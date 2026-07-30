import { z } from 'zod';
import { AdminMutator } from '@garage-ware/shared/mutators';
import { errorResponse, requireAdmin } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const PostBody = z.object({ user_id: z.string().min(1) });
const DeleteBody = z.object({ user_id: z.string().min(1) });

export async function GET(req: Request) {
  try {
    const { pb } = await requireAdmin(req);
    const adminMutator = new AdminMutator(pb);
    const result = await adminMutator.getList(1, 200);
    return Response.json({ items: result.items });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const { pb } = await requireAdmin(req);
    const body = PostBody.parse(await req.json());
    const created = await pb
      .collection('Admins')
      .create({ user: body.user_id });
    return Response.json({ record: created });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const { pb, user } = await requireAdmin(req);
    const body = DeleteBody.parse(await req.json());
    if (body.user_id === user.id) {
      return Response.json(
        { error: 'You cannot demote yourself' },
        { status: 400 }
      );
    }
    const adminMutator = new AdminMutator(pb);
    const record = await adminMutator.findByUser(body.user_id);
    if (!record) {
      return Response.json({ ok: true });
    }
    await pb.collection('Admins').delete(record.id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
