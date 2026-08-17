import {
  getCachedLayout,
  getCachedReplicationFactor,
  getCachedStatus,
} from '@/lib/garage/cached';
import { errorResponse, getServerUser } from '@/lib/auth/server';
import { nodeKey } from '@/lib/node-label';
import type { ClusterNodeItem, ClusterNodesResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await getServerUser(req);
    // Cached: this is the dashboard's critical path, and all three of these
    // were live admin-API calls on every load — `GetClusterStatus` fans out to
    // every peer. Display only; nothing here decides whether capacity exists.
    const [layout, replicationFactor, status] = await Promise.all([
      getCachedLayout(),
      getCachedReplicationFactor(),
      getCachedStatus(),
    ]);
    const statusByNode = new Map(status.nodes.map((n) => [n.id, n]));
    // This payload is served to any signed-in user, and it was the widest of
    // the leaks that made the node id "not actually a secret": it emitted `id`
    // untruncated to every page in the app. It now emits the node KEY, which is
    // the app's only node identifier — see lib/node-label.ts. A handler that
    // needs the full id back resolves it from a live layout through
    // lib/garage/node-resolve.ts; it never travels to a browser.
    //
    // `addr` is deliberately never emitted either — node network addresses stay
    // server-side, the same reason GarageClusterCache is superuser-only.
    // Zone/tags/fill levels are fine (see the node-metrics route docblock).
    // `hostname` is not emitted: it is not how a node is identified, and the
    // only reader was a label the tags now supply.
    const items: ClusterNodeItem[] = layout.roles.map((r) => {
      const s = statusByNode.get(r.id);
      return {
        id: nodeKey(r.id),
        zone: r.zone,
        tags: r.tags ?? [],
        capacity: r.capacity ?? null,
        isUp: s?.isUp ?? null,
        draining: s?.draining ?? null,
        garageVersion: s?.garageVersion ?? null,
        lastSeenSecsAgo: s?.lastSeenSecsAgo ?? null,
        diskFreeBytes: s?.dataPartition?.available ?? null,
        diskTotalBytes: s?.dataPartition?.total ?? null,
        metaFreeBytes: s?.metadataPartition?.available ?? null,
        metaTotalBytes: s?.metadataPartition?.total ?? null,
      };
    });
    const body: ClusterNodesResponse = {
      items,
      replicationFactor,
      layoutVersion: layout.version,
    };
    return Response.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}
