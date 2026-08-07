import 'server-only';
import {
  errorResponse,
  getPbAsSuperuser,
  requireAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

interface RebuildResult {
  users: number;
  nodes: number;
  corrected: number;
  driftGb: number;
}

/**
 * Force a recompute of the storage balance roll-ups from the ledgers.
 *
 * The recompute itself lives in the PocketBase hooks
 * (pb_hooks/lib/storage-balance.js, exposed at POST /api/storage-balances/rebuild
 * behind requireSuperuserAuth) rather than here, so there is exactly one
 * implementation shared with the nightly cron. A second one in TypeScript could
 * disagree with the incremental hooks it is supposed to be auditing.
 *
 * This route is the admin-facing front door: the usual `requireAdmin` gate, then
 * a superuser call through to PocketBase.
 *
 * A non-zero `corrected` is not routine maintenance — it means an incremental
 * hook missed a write path, and the affected users carry the amount in their
 * `last_drift_gb`.
 */
export async function POST(req: Request) {
  try {
    await requireAdmin(req);

    const pb = await getPbAsSuperuser();
    const result = await pb.send<RebuildResult>(
      '/api/storage-balances/rebuild',
      { method: 'POST' }
    );

    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
