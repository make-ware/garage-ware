import {
  getCachedLayout,
  getCachedReplicationFactor,
} from '@/lib/garage/cached';
import { errorResponse, requireAdmin } from '@/lib/auth/server';

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
    return Response.json({ ...layout, replicationFactor });
  } catch (err) {
    return errorResponse(err);
  }
}
