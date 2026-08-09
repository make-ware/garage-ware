import { getCachedHealth } from '@/lib/garage/cached';
import { errorResponse, requireAdmin } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    // Cached — a display read of cluster health, on the same short TTL as
    // status for the same reason.
    const health = await getCachedHealth();
    return Response.json(health);
  } catch (err) {
    return errorResponse(err);
  }
}
