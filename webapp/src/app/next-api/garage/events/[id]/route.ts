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
 * **A detector row may be closed by hand, but only while it is open, and only
 * closed.** The detector opens a condition on a node going offline or leaving
 * the layout and resolves it when the node comes back — but some never come
 * back. A decommissioned node's `node_removed` would sit "in progress" for
 * ever, amber on the cluster map, waiting on an event that cannot happen. This
 * is that escape hatch, and it is deliberately one-way: re-opening a closed
 * detected row would let an admin re-write something a machine measured, which
 * is the whole reason the observed fields are immutable above. The detector may
 * still re-open a row it closed itself, within its flap window; that is a
 * recurrence it observed, not an edit.
 *
 * `action` rows are refused outright — they are born closed, record an instant
 * that had no duration, and were never open to close.
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
    if (body.endedAt !== undefined) {
      // Annotation stays open to every source — saying more later is always
      // useful. Redefining *when* something happened is not: a launched repair
      // is an instant somebody else measured, and an admin does not get to move
      // it. See the docblock for why a detector row is the one exception, and
      // why that exception only closes.
      const isOpenDetected =
        existing.source === 'detector' && !existing.ended_at;
      if (existing.source !== 'manual' && !isOpenDetected) {
        throw new HttpError(
          409,
          existing.source === 'detector'
            ? 'This detected event is already closed — annotate it instead'
            : 'A recorded action has no end date an admin can set'
        );
      }
      if (isOpenDetected && !body.endedAt) {
        throw new HttpError(
          409,
          'A detected event cannot be re-opened by hand'
        );
      }
      // An end before the start would invert the pair and render as a negative
      // duration. Cheap to check, and the datetime-local field behind the
      // manual path makes it an easy typo.
      if (
        body.endedAt &&
        new Date(body.endedAt) <
          new Date(String(existing.occurred_at).replace(' ', 'T'))
      ) {
        throw new HttpError(400, 'An end date cannot precede the start');
      }
      patch.ended_at = body.endedAt;
    }

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
 * Only hand-written notes can go. Everything else — a detector observation, a
 * recorded action — is a record of something that actually happened, and the
 * way to disagree with one is to annotate it. Deleting one would leave the
 * timeline claiming a change never happened, which is exactly the state this
 * collection exists to make impossible. (A row written in error is still
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
    // An ALLOW-list, not a deny-list. This used to refuse only `source:
    // 'detector'`, which silently admitted every source added afterwards — and
    // the first one added was `action`, the row recording that a named admin
    // launched a repair. That is precisely the row that must not be removable
    // by that admin. Checking for the one deletable source instead closes the
    // hole for every future source too.
    if (existing.source !== 'manual') {
      throw new HttpError(
        409,
        existing.source === 'detector'
          ? 'A detected event cannot be deleted — annotate it instead'
          : 'A recorded action cannot be deleted — annotate it instead'
      );
    }

    await pb.collection('ClusterEvents').delete(id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
