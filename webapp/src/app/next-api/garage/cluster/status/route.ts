import { getCachedStatus } from '@/lib/garage/cached';
import { errorResponse, requireAdmin } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    // Cached — `GetClusterStatus` fans out to every peer, and this is a
    // display read. Node liveness moves on its own, hence the short TTL.
    const status = await getCachedStatus();
    return Response.json(status);
  } catch (err) {
    return errorResponse(err);
  }
}
