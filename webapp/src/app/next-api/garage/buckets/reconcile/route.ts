import 'server-only';
import { z } from 'zod';
import { GarageClient, buckets } from '@/lib/garage';
import { requireAdmin, errorResponse } from '@/lib/auth/server';
import { describeQuotaDrift, syncQuotaToPb } from '@/lib/storage/quota-sync';
import { maxObjectsForQuotaGib } from '@/lib/storage/object-quota';
import { gibToBytes } from '@/lib/storage/units';

export const dynamic = 'force-dynamic';

const Body = z
  .object({
    /**
     * `adopt-garage` treats Garage as the source of truth and writes its quota
     * back to PocketBase — the historical behaviour, and the default so the
     * endpoint's existing contract holds.
     *
     * `push-pb` does the reverse. That is the direction that repairs a
     * half-applied PATCH, where Garage never received the new quota: adopting
     * would silently discard the change the admin actually made.
     */
    direction: z.enum(['adopt-garage', 'push-pb']).default('adopt-garage'),
    /**
     * Also reconcile the derived object cap. Off by default: an object cap is a
     * live limit, and recomputing every bucket's because GARAGE_AVG_OBJECT_SIZE_MB
     * changed should be something an admin asks for, not a side effect.
     */
    includeObjects: z.boolean().default(false),
    /** Limit to specific PocketBase bucket ids. Omit for every bucket. */
    bucketIds: z.array(z.string()).optional(),
  })
  .default({ direction: 'adopt-garage', includeObjects: false });

export async function POST(req: Request) {
  try {
    const { pb } = await requireAdmin(req);

    // Tolerate an empty body so the original no-argument call still works.
    let raw: unknown = {};
    try {
      raw = await req.json();
    } catch {
      raw = {};
    }
    const body = Body.parse(raw ?? {});

    const garage = GarageClient.fromEnv();

    const all = await pb.collection('Buckets').getFullList({ batch: 500 });
    const pbBuckets = body.bucketIds
      ? all.filter((b) => body.bucketIds!.includes(b.id))
      : all;

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

        const drift = describeQuotaDrift(pbBucket, r.value);
        const needsWork =
          drift.sizeDrifted || (body.includeObjects && drift.objectsDrifted);
        if (!needsWork) return;

        try {
          if (body.direction === 'adopt-garage') {
            if (drift.sizeDrifted) {
              await syncQuotaToPb(pb, pbBucket, r.value);
            }
            // Adopting Garage's size makes the derived object cap correct by
            // construction, so there is nothing separate to reconcile here.
          } else {
            const quotaGb = pbBucket.quota_gb ?? 0;
            await buckets.updateBucket(garage, {
              id: pbBucket.garage_bucket_id,
              quotas: {
                maxSize: quotaGb > 0 ? gibToBytes(quotaGb) : null,
                maxObjects: maxObjectsForQuotaGib(quotaGb),
              },
            });
          }
          synced++;
        } catch (err) {
          failed++;
          errors.push(`${pbBucket.id}: write failed — ${err}`);
        }
      })
    );

    return Response.json({
      total: pbBuckets.length,
      direction: body.direction,
      synced,
      failed,
      ...(errors.length > 0 && { errors }),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
