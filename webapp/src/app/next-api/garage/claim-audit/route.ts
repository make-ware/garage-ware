import { z } from 'zod';
import { StorageClaimAuditMutator } from '@garage-ware/shared/mutators';
import { CLAIM_AUDIT_ACTIONS } from '@garage-ware/shared';
import { errorResponse, requireAdmin } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

// Deliberately a sibling of `claims/`, not `claims/audit/`: the latter would
// sit next to the existing `claims/[id]` dynamic segment. Next.js resolves the
// static segment first so it would work, but the ambiguity is not worth it.

const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 200;

const Query = z.object({
  userId: z.string().max(32).optional(),
  nodeId: z.string().max(128).optional(),
  claimId: z.string().max(32).optional(),
  action: z.enum(CLAIM_AUDIT_ACTIONS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PER_PAGE)
    .default(DEFAULT_PER_PAGE),
});

/**
 * Browse the StorageClaims audit trail. Admin-only, matching the collection's
 * own listRule — the rows name who changed whose grant, so they are not a
 * per-user resource the way claims and transfers are.
 */
export async function GET(req: Request) {
  try {
    const { pb } = await requireAdmin(req);
    const url = new URL(req.url);
    const query = Query.parse({
      userId: url.searchParams.get('userId') ?? undefined,
      nodeId: url.searchParams.get('nodeId') ?? undefined,
      claimId: url.searchParams.get('claimId') ?? undefined,
      action: url.searchParams.get('action') ?? undefined,
      page: url.searchParams.get('page') ?? undefined,
      perPage: url.searchParams.get('perPage') ?? undefined,
    });

    const audit = new StorageClaimAuditMutator(pb);
    const result = await audit.search(query.page, query.perPage, {
      userId: query.userId,
      nodeId: query.nodeId,
      claimId: query.claimId,
      action: query.action,
    });

    return Response.json({
      items: result.items,
      page: result.page,
      perPage: result.perPage,
      totalItems: result.totalItems,
      totalPages: result.totalPages,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
