import { GarageClient, cluster } from '@/lib/garage';
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

    const garage = GarageClient.fromEnv();
    const layout = await cluster.getLayout(garage);

    const summary = await getUserStorageSummary(pb, targetUserId, layout);
    return Response.json(summary);
  } catch (err) {
    return errorResponse(err);
  }
}
