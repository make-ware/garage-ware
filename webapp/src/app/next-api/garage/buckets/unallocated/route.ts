import { GarageClient, buckets } from '@/lib/garage';
import { errorResponse, requireAdmin } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export interface UnallocatedBucket {
  id: string;
  globalAliases: string[];
  bytes?: number;
  objects?: number;
  maxSize?: number | null;
  maxObjects?: number | null;
}

export async function GET(req: Request) {
  try {
    const { pb } = await requireAdmin(req);

    const allocatedRows = await pb.collection('Buckets').getFullList({
      fields: 'garage_bucket_id',
    });
    const allocated = new Set(allocatedRows.map((r) => r.garage_bucket_id));

    const garage = GarageClient.fromEnv();
    const all = await buckets.listBuckets(garage);
    const unclaimed = all.filter((b) => !allocated.has(b.id));

    const settled = await Promise.allSettled(
      unclaimed.map((b) => buckets.getBucketInfo(garage, { id: b.id }))
    );

    const items: UnallocatedBucket[] = unclaimed.map((b, i) => {
      const info = settled[i];
      if (info.status === 'fulfilled') {
        return {
          id: b.id,
          globalAliases: info.value.globalAliases,
          bytes: info.value.bytes,
          objects: info.value.objects,
          maxSize: info.value.quotas?.maxSize ?? null,
          maxObjects: info.value.quotas?.maxObjects ?? null,
        };
      }
      console.error(
        '[buckets/unallocated] info fetch failed:',
        b.id,
        info.reason
      );
      return { id: b.id, globalAliases: b.globalAliases };
    });

    return Response.json({ items });
  } catch (err) {
    return errorResponse(err);
  }
}
