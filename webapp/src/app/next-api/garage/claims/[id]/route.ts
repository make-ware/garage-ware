import { z } from 'zod';
import { StorageClaimMutator } from '@garage-ware/shared/mutators';
import { GarageClient } from '@/lib/garage';
import {
  assertClaimDeltaAllowed,
  loadClaimContext,
} from '@/lib/storage/claim-ledger';
import { actorHeaders } from '@/lib/storage/claim-write';
import { assertNodeOwner } from '@/lib/auth/ownership';
import {
  HttpError,
  errorResponse,
  getPbAsSuperuser,
  getServerUser,
  isUserAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

// Correcting a mistyped ledger entry, not restating the user's total: the
// amount is signed, and the delta applied to the ledger is (new - old).
const PatchBody = z.object({
  quota_gb: z
    .number()
    .refine((v) => v !== 0, 'Adjustment must be a non-zero amount')
    .optional(),
  note: z.string().max(500).optional(),
});

/**
 * Admin, or the owner of the node this entry is sourced from.
 *
 * An owner may edit and delete entries on their own node whoever they were
 * granted to, because those entries are what fills the ceiling they are
 * responsible for. They cannot touch an entry on any other node.
 */
async function authorizeEntry(
  pb: Parameters<typeof isUserAdmin>[0],
  nodeId: string,
  userId: string
): Promise<boolean> {
  const isAdmin = await isUserAdmin(pb, userId);
  if (!isAdmin) await assertNodeOwner(pb, nodeId, userId, false);
  return isAdmin;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { pb, user } = await getServerUser(req);
    const { id } = await ctx.params;
    const body = PatchBody.parse(await req.json());

    // Read as a superuser: the StorageClaims listRule is `user = self || admin`,
    // so a node owner cannot see an entry granted to somebody else on their own
    // node — which is exactly the entry they may need to correct.
    const superuserPb = await getPbAsSuperuser();
    const claims = new StorageClaimMutator(superuserPb);
    const record = await claims.getById(id);
    if (!record) throw new HttpError(404, 'Claim entry not found');

    const isAdmin = await authorizeEntry(pb, record.node_id, user.id);

    const previousGb = Number(record.quota_gb) || 0;
    const nextGb = body.quota_gb ?? previousGb;

    if (nextGb !== previousGb) {
      const claimCtx = await loadClaimContext(GarageClient.fromEnv());
      // Superuser: the guard must read every balance row, not the caller's.
      await assertClaimDeltaAllowed(superuserPb, claimCtx, {
        userId: record.user,
        nodeId: record.node_id,
        deltaGb: nextGb - previousGb,
      });
    }

    const updated = await superuserPb.collection('StorageClaims').update(
      record.id,
      {
        quota_gb: nextGb,
        ...(body.note !== undefined ? { note: body.note || undefined } : {}),
      },
      { headers: actorHeaders(user, isAdmin ? 'api' : 'node-owner') }
    );
    return Response.json({ record: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { pb, user } = await getServerUser(req);
    const { id } = await ctx.params;

    const superuserPb = await getPbAsSuperuser();
    const claims = new StorageClaimMutator(superuserPb);
    const record = await claims.getById(id);
    if (!record) throw new HttpError(404, 'Claim entry not found');

    const isAdmin = await authorizeEntry(pb, record.node_id, user.id);

    // Removing an entry is a delta of -amount, so a positive grant has to
    // survive the same guards a negative adjustment would.
    const claimCtx = await loadClaimContext(GarageClient.fromEnv());
    await assertClaimDeltaAllowed(superuserPb, claimCtx, {
      userId: record.user,
      nodeId: record.node_id,
      deltaGb: -(Number(record.quota_gb) || 0),
    });

    await superuserPb.collection('StorageClaims').delete(record.id, {
      headers: actorHeaders(user, isAdmin ? 'api' : 'node-owner'),
    });
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
