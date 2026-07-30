import { GarageClient, keys } from '@/lib/garage';
import { errorResponse, requireAdmin } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export interface UnallocatedKey {
  id: string;
  name?: string;
  expired?: boolean;
  bucketCount?: number;
}

export async function GET(req: Request) {
  try {
    const { pb } = await requireAdmin(req);

    const allocatedRows = await pb.collection('AccessKeys').getFullList({
      fields: 'garage_key_id',
    });
    const allocated = new Set(allocatedRows.map((r) => r.garage_key_id));

    const garage = GarageClient.fromEnv();
    const all = await keys.listKeys(garage);
    const unclaimed = all.filter((k) => !allocated.has(k.id));

    const settled = await Promise.allSettled(
      unclaimed.map((k) => keys.getKeyInfo(garage, k.id))
    );

    const items: UnallocatedKey[] = unclaimed.map((k, i) => {
      const info = settled[i];
      if (info.status === 'fulfilled') {
        return {
          id: k.id,
          name: info.value.name,
          expired: info.value.expired,
          bucketCount: info.value.buckets?.length ?? 0,
        };
      }
      console.error('[keys/unallocated] info fetch failed:', k.id, info.reason);
      return { id: k.id, name: k.name };
    });

    return Response.json({ items });
  } catch (err) {
    return errorResponse(err);
  }
}
