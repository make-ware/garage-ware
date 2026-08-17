import { getCachedStatus } from '@/lib/garage/cached';
import { errorResponse, requireAdmin } from '@/lib/auth/server';
import { nodeKey } from '@/lib/node-label';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    // Cached — `GetClusterStatus` fans out to every peer, and this is a
    // display read. Node liveness moves on its own, hence the short TTL.
    const status = await getCachedStatus();
    // Keyed even though this route is admin-only. The full id is a credential
    // (see lib/node-label.ts) and admins are not exempt from that — nothing
    // renders one, and a handler needing one resolves it server-side through
    // lib/garage/node-resolve.ts. Keying here also keeps `addrByNodeId` on
    // /admin/cluster joinable against every other payload, all of which carry
    // keys.
    return Response.json({
      ...status,
      nodes: status.nodes.map((n) => ({ ...n, id: nodeKey(n.id) })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
