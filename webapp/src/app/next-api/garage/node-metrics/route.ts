import 'server-only';
import { z } from 'zod';
import {
  errorResponse,
  getPbAsSuperuser,
  getServerUser,
} from '@/lib/auth/server';
import type { NodeMetricsHistory } from '@/lib/types';

export const dynamic = 'force-dynamic';

const Query = z.object({
  range: z.enum(['6h', '24h', '7d', '30d']).default('24h'),
});

/**
 * Bucketed per-node metrics history for the /dashboard/metrics charts.
 *
 * The aggregation lives in PocketBase (GET /api/node-metrics/history behind
 * requireSuperuserAuth, implemented in pb_hooks/lib/node-metrics.js) where the
 * raw window — up to ~23k rows at 30d — is one in-process read instead of
 * dozens of paged HTTP requests. This route is the front door: any signed-in
 * user, then a superuser call through to PocketBase.
 *
 * Read-only and open to every authenticated user on purpose — cluster health
 * is what a user's own storage rides on, and the payload carries node
 * hostnames, zones, and fill levels but nothing about who stores what. The
 * `NodeMetrics` collection rules stay admin-only, so this route (not a direct
 * PB read) is the only door. Recording a sample is a different question, and
 * `POST .../scrape` keeps its `requireAdmin` gate.
 */
export async function GET(req: Request) {
  try {
    await getServerUser(req);
    const url = new URL(req.url);
    const query = Query.parse({
      range: url.searchParams.get('range') ?? undefined,
    });

    const pb = await getPbAsSuperuser();
    const result = await pb.send<NodeMetricsHistory>(
      `/api/node-metrics/history?range=${query.range}`,
      { method: 'GET' }
    );

    return Response.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
