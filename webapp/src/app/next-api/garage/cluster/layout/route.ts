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
    //
    // **`stagedRoleChanges` carries ids too**, and used to ride out through the
    // spread untouched — so this route emitted full 64-character node ids the
    // moment anything was staged, and `node-id-boundary.test.ts` missed it only
    // because its fixture had none. Keyed here, and the fixture now has two.
    return Response.json({
      ...layout,
      roles: layout.roles.map((r) => ({ ...r, id: nodeKey(r.id) })),
      stagedRoleChanges: layout.stagedRoleChanges?.map((c) => ({
        ...c,
        id: nodeKey(c.id),
      })),
      replicationFactor,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
