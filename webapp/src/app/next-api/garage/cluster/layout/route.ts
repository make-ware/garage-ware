import {
  getCachedLayout,
  getCachedReplicationFactor,
} from '@/lib/garage/cached';
import { errorResponse, requireAdmin } from '@/lib/auth/server';
import { nodeKey } from '@/lib/node-label';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    // Cached — an admin display of the layout. Mutation paths that must not
    // act on a stale layout call `cluster.getLayout` directly.
    const [layout, replicationFactor] = await Promise.all([
      getCachedLayout(),
      getCachedReplicationFactor(),
    ]);
    // Role ids reduced to node keys. Its three readers (/admin, /admin/claims,
    // /admin/ledger) use them only to label rows and to fill node pickers, and
    // every row they are matched against carries a key.
    return Response.json({
      ...layout,
      roles: layout.roles.map((r) => ({ ...r, id: nodeKey(r.id) })),
      replicationFactor,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
