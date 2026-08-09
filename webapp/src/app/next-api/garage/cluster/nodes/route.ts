import {
  getCachedLayout,
  getCachedReplicationFactor,
  getCachedStatus,
} from '@/lib/garage/cached';
import { errorResponse, getServerUser } from '@/lib/auth/server';

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
    const diskByNode = new Map(
      status.nodes.map((n) => [
        n.id,
        n.dataPartition
          ? { free: n.dataPartition.available, total: n.dataPartition.total }
          : null,
      ])
    );
    const items = layout.roles.map((r) => {
      const disk = diskByNode.get(r.id) ?? null;
      return {
        id: r.id,
        zone: r.zone,
        tags: r.tags ?? [],
        capacity: r.capacity ?? null,
        diskFreeBytes: disk?.free ?? null,
        diskTotalBytes: disk?.total ?? null,
      };
    });
    return Response.json({ items, replicationFactor });
  } catch (err) {
    return errorResponse(err);
  }
}
