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
  layoutFailed: number;
  pruned: number;
  /**
   * What this scrape did to the cluster timeline. Three figures rather than
   * one, because closing an outage and opening one are different facts about a
   * cluster: `created` is new rows, `reopened` is conditions that recurred
   * inside the flap window and folded back into their existing row, `closed` is
   * conditions this scrape found had cleared.
   */
  events: { created: number; reopened: number; closed: number };
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
 *
 * The same call also advances the cluster timeline: the scraper diffs this
 * sample against the previous one to append what changed, and closes any open
 * condition — a node offline, a node out of the layout — that this sample shows
 * has cleared. Both are reported back as `events`.
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
