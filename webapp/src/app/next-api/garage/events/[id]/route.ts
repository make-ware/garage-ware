import 'server-only';
import { z } from 'zod';
import {
  HttpError,
  errorResponse,
  getPbAsSuperuser,
  requireAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

/**
 * Annotate a timeline entry, or close an open one.
 *
 * **Only the human fields are writable.** `kind`, `severity`, the node
 * snapshot and `previous_value` / `new_value` are what a machine measured, and
 * a log whose observations can be edited afterwards is not a log. That holds
 * for manual rows too: a note's own text is fixed once written, and anything
 * further to say goes in the annotation, in order, where the reader can see
 * that it came later.
 *
 * `endedAt` is the exception, because "when did this stop" is genuinely not
 * knowable when the row is created — it is what closes an open repair and
 * clears a node's "under repair" state. Passing an empty string re-opens one.
 *
 * All writes go through a superuser: the collection's write rules are null, so
 * this route is the only door.
 */
const PatchBody = z
  .object({
    annotation: z.string().max(2000).optional(),
    /** ISO 8601, or '' to re-open. */
    endedAt: z.string().max(40).optional(),
  })
  .refine(
    (b) => b.annotation !== undefined || b.endedAt !== undefined,
    'Nothing to update'
  );

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { user } = await requireAdmin(req);
    const { id } = await ctx.params;
    const body = PatchBody.parse(await req.json());

    const pb = await getPbAsSuperuser();
    const existing = await pb
      .collection('ClusterEvents')
      .getOne(id)
      .catch(() => null);
    if (!existing) throw new HttpError(404, 'Event not found');

    const patch: Record<string, string> = {};
    if (body.annotation !== undefined) {
      patch.annotation = body.annotation;
      // Stamped together, so an annotation always says who and when. Cleared
      // alongside the text, or a blanked note would keep a stale byline.
      patch.annotated_by = body.annotation ? (user.email ?? user.id) : '';
      patch.annotated_at = body.annotation ? new Date().toISOString() : '';
    }
    if (body.endedAt !== undefined) patch.ended_at = body.endedAt;

    const record = await pb.collection('ClusterEvents').update(id, patch);
    return Response.json(record);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}

/**
 * Remove a hand-written note.
 *
 * Detector rows are refused. They record something that was actually observed,
 * and the way to disagree with one is to annotate it — deleting it would leave
 * the timeline claiming a change never happened, which is exactly the state
 * this collection exists to make impossible. (A row written in error is still
 * removable from the PocketBase admin UI by a superuser, deliberately out of
 * the app's reach.)
 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin(req);
    const { id } = await ctx.params;

    const pb = await getPbAsSuperuser();
    const existing = await pb
      .collection('ClusterEvents')
      .getOne(id)
      .catch(() => null);
    if (!existing) throw new HttpError(404, 'Event not found');
    if (existing.source === 'detector') {
      throw new HttpError(
        409,
        'A detected event cannot be deleted — annotate it instead'
      );
    }

    await pb.collection('ClusterEvents').delete(id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
