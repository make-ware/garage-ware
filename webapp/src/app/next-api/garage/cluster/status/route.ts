import { GarageClient, cluster } from '@/lib/garage';
import { errorResponse, requireAdmin } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const garage = GarageClient.fromEnv();
    const status = await cluster.getStatus(garage);
    return Response.json(status);
  } catch (err) {
    return errorResponse(err);
  }
}
