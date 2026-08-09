import 'server-only';
import {
  errorResponse,
  getPbAsSuperuser,
  requireAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

interface ScrapeResult {
  skipped?: boolean;
  recorded: number;
  statsFailed: number;
  pruned: number;
  errors: number;
}

/**
 * Record one metrics sample per node right now, without waiting for the
 * 15-minute `node-metrics-scrape` cron tick.
 *
 * The scrape itself lives in the PocketBase hooks
 * (pb_hooks/lib/node-metrics.js, exposed at POST /api/node-metrics/scrape
 * behind requireSuperuserAuth) rather than here, so there is exactly one
 * implementation shared with the cron. This route is the admin-facing front
 * door: the usual `requireAdmin` gate, then a superuser call through to
 * PocketBase.
 *
 * PocketBase answers 503 when GARAGE_ADMIN_URL/GARAGE_ADMIN_TOKEN are not set
 * in its environment — that surfaces to the UI as an error rather than a
 * silently empty "success".
 */
export async function POST(req: Request) {
  try {
    await requireAdmin(req);

    const pb = await getPbAsSuperuser();
    const result = await pb.send<ScrapeResult>('/api/node-metrics/scrape', {
      method: 'POST',
    });

    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
