import { z } from 'zod';
import { StorageClaimMutator } from '@garage-ware/shared/mutators';
import { GarageClient, cluster } from '@/lib/garage';
import {
  assertClaimDeltaAllowed,
  loadClaimContext,
} from '@/lib/storage/claim-ledger';
import {
  HttpError,
  errorResponse,
  getServerUser,
  isUserAdmin,
  requireAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  user_id: z.string().min(1),
  node_id: z.string().min(1).max(128),
  // Signed: a positive entry grants, a negative entry reclaims. Zero would be
  // a no-op row, so it is rejected rather than written to the ledger.
  quota_gb: z
    .number()
    .refine((v) => v !== 0, 'Adjustment must be a non-zero amount'),
  note: z.string().max(500).optional(),
});

export async function GET(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const url = new URL(req.url);
    const requestedUserId = url.searchParams.get('userId');
    const all = url.searchParams.get('all') === 'true';
    const nodeId = url.searchParams.get('nodeId');

    const claims = new StorageClaimMutator(pb);

    if (all || nodeId || (requestedUserId && requestedUserId !== user.id)) {
      const admin = await isUserAdmin(pb, user.id);
      if (!admin) throw new HttpError(403, 'Admin privileges required');
      if (nodeId) {
        const result = await claims.listByNode(nodeId);
        return Response.json({ items: result.items });
      }
      if (all) {
        const result = await claims.getList(1, 500);
        return Response.json({ items: result.items });
      }
      const result = await claims.listByUser(requestedUserId!);
      return Response.json({ items: result.items });
    }

    const result = await claims.listByUser(user.id);
    return Response.json({ items: result.items });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const { pb } = await requireAdmin(req);
    const body = CreateBody.parse(await req.json());

    const garage = GarageClient.fromEnv();
    const [ctx, status] = await Promise.all([
      loadClaimContext(garage),
      cluster.getStatus(garage),
    ]);

    const role = ctx.layout.roles.find((r) => r.id === body.node_id);
    if (!role) {
      throw new HttpError(
        400,
        `Node ${body.node_id} is not present in the cluster layout`
      );
    }
    if (!role.capacity || role.capacity <= 0) {
      throw new HttpError(400, `Node ${body.node_id} has no declared capacity`);
    }

    await assertClaimDeltaAllowed(pb, ctx, {
      userId: body.user_id,
      nodeId: body.node_id,
      deltaGb: body.quota_gb,
    });

    const node = status.nodes.find((n) => n.id === body.node_id);
    const record = await pb.collection('StorageClaims').create({
      user: body.user_id,
      node_id: body.node_id,
      node_hostname: node?.hostname ?? undefined,
      node_zone: role.zone,
      quota_gb: body.quota_gb,
      note: body.note || undefined,
    });

    return Response.json({ record });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
