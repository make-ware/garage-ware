import { getCachedLayout } from '@/lib/garage/cached';
import { getUserStorageSummary } from '@/lib/storage/summary';
import {
  HttpError,
  errorResponse,
  getServerUser,
  isUserAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const url = new URL(req.url);
    const requestedUserId = url.searchParams.get('userId');

    let targetUserId = user.id;
    if (requestedUserId && requestedUserId !== user.id) {
      const admin = await isUserAdmin(pb, user.id);
      if (!admin) throw new HttpError(403, 'Admin privileges required');
      targetUserId = requestedUserId;
    }

    // Cached: the layout is only used here to value claims for display, and
    // this runs on every dashboard load. A minute-old layout means a node that
    // has just left the cluster keeps counting for up to a minute *on screen*;
    // every path that spends or grants capacity still reads it live.
    const layout = await getCachedLayout();

    const summary = await getUserStorageSummary(pb, targetUserId, layout);
    return Response.json(summary);
  } catch (err) {
    return errorResponse(err);
  }
}
