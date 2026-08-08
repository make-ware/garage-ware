import { StorageInviteMutator } from '@garage-ware/shared/mutators';
import {
  HttpError,
  errorResponse,
  getServerUser,
  isUserAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

/**
 * Cancel an invite, or clear a settled one off the sender's list.
 *
 * Deleting is the only way to unwind an invite, exactly as deleting is how a
 * transfer is returned. Nothing needs unwinding on the balance side: a pending
 * invite never moved capacity, and a claimed one already became a transfer
 * that owns its own accounting. Deleting a claimed invite therefore removes
 * the record of the promise, never the storage.
 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { pb, user } = await getServerUser(req);
    const { id } = await ctx.params;

    const invites = new StorageInviteMutator(pb);
    const record = await invites.getById(id);
    if (!record) throw new HttpError(404, 'Invite not found');

    if (record.from_user !== user.id && !(await isUserAdmin(pb, user.id))) {
      throw new HttpError(
        403,
        'Only the sender or an admin can cancel an invite'
      );
    }

    await pb.collection('StorageInvites').delete(id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
