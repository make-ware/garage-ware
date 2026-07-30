import 'server-only';
import { GarageClient, buckets } from '@/lib/garage';
import { requireAdmin, errorResponse } from '@/lib/auth/server';
import { quotaHasDrifted, syncQuotaToPb } from '@/lib/storage/quota-sync';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { pb } = await requireAdmin(req);
    const garage = GarageClient.fromEnv();

    const pbBuckets = await pb
      .collection('Buckets')
      .getFullList({ batch: 500 });

    const garageResults = await Promise.allSettled(
      pbBuckets.map((b) =>
        buckets.getBucketInfo(garage, { id: b.garage_bucket_id })
      )
    );

    let synced = 0;
    let failed = 0;
    const errors: string[] = [];

    await Promise.all(
      pbBuckets.map(async (pbBucket, i) => {
        const r = garageResults[i];
        if (r.status === 'rejected') {
          failed++;
          errors.push(`${pbBucket.id}: garage fetch failed — ${r.reason}`);
          return;
        }
        if (!quotaHasDrifted(pbBucket, r.value)) return;
        try {
          await syncQuotaToPb(pb, pbBucket, r.value);
          synced++;
        } catch (err) {
          failed++;
          errors.push(`${pbBucket.id}: write failed — ${err}`);
        }
      })
    );

    return Response.json({
      total: pbBuckets.length,
      synced,
      failed,
      ...(errors.length > 0 && { errors }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
