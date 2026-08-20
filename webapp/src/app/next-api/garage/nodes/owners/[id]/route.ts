import { NodeOwnerMutator } from '@garage-ware/shared/mutators';
import {
  HttpError,
  errorResponse,
  getPbAsSuperuser,
  getServerUser,
  isUserAdmin,
} from '@/lib/auth/server';
import { featureNodeClaims } from '@/lib/setup/features';
import { writeTimelineActionRow } from '@/lib/cluster/timeline-write';

export const dynamic = 'force-dynamic';

/**
 * Release or revoke node ownership.
 *
 * There is deliberately no PATCH. Reassignment is a delete followed by a
 * create, so every change leaves its own timeline row and there is no
 * partial-edit path — the same reasoning behind `StorageTransfers.updateRule:
 * null`, where a handoff is corrected by removing it rather than editing it.
 *
 * Existing StorageClaims rows are untouched by any of this. The ledger is
 * append-only and its entries record what was granted, not who was entitled to
 * grant it; unwinding a claim is a negative entry, which is a separate act.
 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { pb, user } = await getServerUser(req);
    const { id } = await ctx.params;

    // The NodeOwners listRule is self-or-admin, so this read is itself the
    // ownership check: a non-admin who does not own the row gets nothing back.
    const owners = new NodeOwnerMutator(pb);
    const record = await owners.getById(id);
    if (!record) throw new HttpError(404, 'Node ownership record not found');

    let isAdmin = false;
    if (record.user !== user.id) {
      isAdmin = await isUserAdmin(pb, user.id);
      if (!isAdmin) throw new HttpError(403, 'You do not own this node');
    } else if (!featureNodeClaims()) {
      // Self-release is the inverse of self-claiming, so the same flag closes
      // it: where administrators decide who owns what, they also decide when
      // that stops. The row is not inert meanwhile — the owner can still grant
      // storage sourced from the node — they simply cannot hand it back
      // themselves. Admins revoke as usual.
      isAdmin = await isUserAdmin(pb, user.id);
      if (!isAdmin)
        throw new HttpError(
          403,
          'Node claiming is disabled on this instance. Ask an administrator.'
        );
    }

    // Write rules are null; only the superuser client can delete.
    const superuserPb = await getPbAsSuperuser();
    await superuserPb.collection('NodeOwners').delete(record.id);

    const logged = await writeTimelineActionRow({
      kind: 'node_owner_changed',
      nodeId: record.node_id,
      title: isAdmin ? 'Node ownership revoked' : 'Node ownership released',
      severity: 'info',
      // Raw ids; empty `new_value` is what "unowned" looks like here.
      previousValue: record.user,
      newValue: '',
      actorId: user.id,
      actorEmail: user.email ?? '',
      logLabel: '[node-owners] ownership removed but',
    });

    return Response.json({ ok: true, logged });
  } catch (err) {
    return errorResponse(err);
  }
}
