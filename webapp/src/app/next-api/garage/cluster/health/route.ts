import { GarageClient } from '@/lib/garage';
import { cluster } from '@/lib/garage';
import { errorResponse, requireAdmin } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const garage = GarageClient.fromEnv();
    const health = await cluster.getHealth(garage);
    return Response.json(health);
  } catch (err) {
    return errorResponse(err);
  }
}
