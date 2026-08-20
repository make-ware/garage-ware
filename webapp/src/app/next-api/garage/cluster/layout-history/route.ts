import 'server-only';
import { GarageClient, cluster } from '@/lib/garage';
import { errorResponse, requireAdmin } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

/**
 * Past layout versions — read-only, admin-only.
 *
 * Projected **field by field**, never spread. `GetClusterLayoutHistory` also
 * returns `updateTrackers`, a map *keyed by full node id*; the schema in
 * `lib/garage/schemas.ts` drops it before it is ever an object in this process,
 * and this projection is the second gate. `minAck` answers the only question
 * the page asks of it — "have all the nodes caught up" — without naming any
 * node at all.
 *
 * Live rather than cached, like everything else under `/cluster/staging`: the
 * page it feeds is about acting on the layout, and this is one small read.
 *
 * Garage attaches **no timestamps** to these versions, so the page says so and
 * points at `/admin/events`, which is where when-and-by-whom actually lives.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const garage = GarageClient.fromEnv();
    const history = await cluster.getLayoutHistory(garage);

    return Response.json({
      currentVersion: history.currentVersion,
      minAck: history.minAck,
      versions: history.versions.map((v) => ({
        version: v.version,
        status: v.status,
        storageNodes: v.storageNodes,
        gatewayNodes: v.gatewayNodes,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
