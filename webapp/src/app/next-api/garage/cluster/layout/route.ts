import { GarageClient, cluster } from '@/lib/garage';
import { errorResponse, requireAdmin } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const garage = GarageClient.fromEnv();
    const [layout, replicationFactor] = await Promise.all([
      cluster.getLayout(garage),
      cluster.getReplicationFactor(garage),
    ]);
    return Response.json({ ...layout, replicationFactor });
  } catch (err) {
    return errorResponse(err);
  }
}
