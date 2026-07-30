import { z } from 'zod';
import { StorageClaimMutator } from '@garage-ware/shared/mutators';
import { GarageClient } from '@/lib/garage';
import {
  assertClaimDeltaAllowed,
  loadClaimContext,
} from '@/lib/storage/claim-ledger';
import { HttpError, errorResponse, requireAdmin } from '@/lib/auth/server';

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

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { pb } = await requireAdmin(req);
    const { id } = await ctx.params;
    const body = PatchBody.parse(await req.json());

    const claims = new StorageClaimMutator(pb);
    const record = await claims.getById(id);
    if (!record) throw new HttpError(404, 'Claim entry not found');

    const previousGb = Number(record.quota_gb) || 0;
    const nextGb = body.quota_gb ?? previousGb;

    if (nextGb !== previousGb) {
      const claimCtx = await loadClaimContext(GarageClient.fromEnv());
      await assertClaimDeltaAllowed(pb, claimCtx, {
        userId: record.user,
        nodeId: record.node_id,
        deltaGb: nextGb - previousGb,
      });
    }

    const updated = await pb.collection('StorageClaims').update(record.id, {
      quota_gb: nextGb,
      ...(body.note !== undefined ? { note: body.note || undefined } : {}),
    });
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
    const { pb } = await requireAdmin(req);
    const { id } = await ctx.params;

    const claims = new StorageClaimMutator(pb);
    const record = await claims.getById(id);
    if (!record) throw new HttpError(404, 'Claim entry not found');

    // Removing an entry is a delta of -amount, so a positive grant has to
    // survive the same guards a negative adjustment would.
    const claimCtx = await loadClaimContext(GarageClient.fromEnv());
    await assertClaimDeltaAllowed(pb, claimCtx, {
      userId: record.user,
      nodeId: record.node_id,
      deltaGb: -(Number(record.quota_gb) || 0),
    });

    await pb.collection('StorageClaims').delete(record.id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
