import { GarageClient, cluster } from '@/lib/garage';
import { errorResponse, getServerUser } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await getServerUser(req);
    const garage = GarageClient.fromEnv();
    const [layout, replicationFactor, status] = await Promise.all([
      cluster.getLayout(garage),
      cluster.getReplicationFactor(garage),
      cluster.getStatus(garage),
    ]);
    const diskByNode = new Map(
      status.nodes.map((n) => [
        n.id,
        n.dataPartition
          ? { free: n.dataPartition.available, total: n.dataPartition.total }
          : null,
      ])
    );
    const items = layout.roles.map((r) => {
      const disk = diskByNode.get(r.id) ?? null;
      return {
        id: r.id,
        zone: r.zone,
        tags: r.tags ?? [],
        capacity: r.capacity ?? null,
        diskFreeBytes: disk?.free ?? null,
        diskTotalBytes: disk?.total ?? null,
      };
    });
    return Response.json({ items, replicationFactor });
  } catch (err) {
    return errorResponse(err);
  }
}
