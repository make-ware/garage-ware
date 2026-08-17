import { StorageTransferMutator } from '@garage-ware/shared/mutators';
import { formatStorage } from '@/lib/format';
import { getUserPosition } from '@/lib/storage/summary';
import { GarageClient, cluster } from '@/lib/garage';
import {
  HttpError,
  errorResponse,
  getServerUser,
  isUserAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { pb, user } = await getServerUser(req);
    const { id } = await ctx.params;

    const transfers = new StorageTransferMutator(pb);
    const record = await transfers.getById(id);
    if (!record) throw new HttpError(404, 'Transfer not found');

    const admin = await isUserAdmin(pb, user.id);
    if (record.to_user !== user.id && !admin) {
      throw new HttpError(
        403,
        'Only the recipient or an admin can return a transfer'
      );
    }

    // Safety check: would the recipient be over-allocated without this transfer?
    const garage = GarageClient.fromEnv();
    const layout = await cluster.getLayout(garage);
    // One read, not two: the recipient is either the caller or the caller is an
    // admin, so their own client can see these rows.
    const { netGrantedGb, allocatedGb } = await getUserPosition(
      pb,
      record.to_user,
      layout
    );
    const grantedGbAfter = netGrantedGb - (Number(record.quota_gb) || 0);

    if (grantedGbAfter < allocatedGb) {
      throw new HttpError(
        409,
        `Returning this transfer would leave the recipient ${formatStorage(allocatedGb - grantedGbAfter)} over their remaining capacity. Reduce or remove their bucket quotas first.`
      );
    }

    await pb.collection('StorageTransfers').delete(id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
