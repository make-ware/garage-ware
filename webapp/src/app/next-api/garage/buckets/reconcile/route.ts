import 'server-only';
import { z } from 'zod';
import { GarageClient, buckets } from '@/lib/garage';
import {
  requireAdmin,
  errorResponse,
  getPbAsSuperuser,
} from '@/lib/auth/server';
import { describeQuotaDrift, syncQuotaToPb } from '@/lib/storage/quota-sync';
import {
  effectiveMaxObjectsFor,
  maxObjectsForQuotaGib,
} from '@/lib/storage/object-quota';
import { bytesToGib, gibToBytes } from '@/lib/storage/units';

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

    // Every write below is to Buckets, whose three write rules are null since
    // 1787600000_lock_asset_write_rules.js — the caller's own admin client
    // cannot write the collection at all. Resolved once, up here, rather than
    // per branch: it is memoized, and having exactly one client in scope is
    // what stops a second write path being added against `pb` by mistake, which
    // is how the object-quota branch below came to be rejected on every call.
    const writePb = await getPbAsSuperuser();

    await Promise.all(
      pbBuckets.map(async (pbBucket, i) => {
        const r = garageResults[i];
        if (r.status === 'rejected') {
          failed++;
          errors.push(`${pbBucket.id}: garage fetch failed — ${r.reason}`);
          return;
        }

        const drift = describeQuotaDrift(pbBucket, r.value);
        const fixSize = drift.sizeDrifted;
        const fixObjects = body.includeObjects && drift.objectsDrifted;
        if (!fixSize && !fixObjects) return;

        try {
          // Tracked rather than assumed. A bucket counts as synced only if
          // something was actually written for it, and a refusal is reported as
          // a failure with its reason — see the size branch below.
          let wrote = false;
          let refusal: string | null = null;

          if (body.direction === 'adopt-garage') {
            if (fixSize) {
              // The self-heal refuses an adoption that would over-allocate the
              // owner. On a dashboard load that silence is right; here an admin
              // has explicitly asked for the repair, so reporting `synced` for a
              // bucket it declined to touch would claim a job the drift page
              // contradicts on the next render.
              const outcome = await syncQuotaToPb(pb, pbBucket, r.value);
              if (outcome.status === 'refused') refusal = outcome.reason;
              else if (outcome.status === 'written') wrote = true;
            }
            if (fixObjects) {
              if (drift.garageMaxObjects > 0) {
                // The object axis DOES have a PocketBase side now:
                // `object_quota`. Adopting means recording the cap Garage
                // already enforces as the deliberate one. The live limit does
                // not move — only the disagreement does, which is exactly what
                // "adopt Garage as the truth" should mean on this axis.
                await writePb.collection('Buckets').update(pbBucket.id, {
                  object_quota: drift.garageMaxObjects,
                });
              } else {
                // Garage caps nothing, and `object_quota: 0` cannot say
                // "uncapped" — it says "derive". So there is no PocketBase
                // value to adopt and the only repair is the historical one:
                // write Garage the derived cap. Reachable only when an average
                // IS configured; with none, the expectation is null, Garage's 0
                // already matches, and `objectsDrifted` was false.
                //
                // Clear any stale override first so the two agree once the
                // write lands, and derive rather than read the override back —
                // the in-memory record still holds the value just cleared.
                if ((pbBucket.object_quota ?? 0) !== 0) {
                  await writePb
                    .collection('Buckets')
                    .update(pbBucket.id, { object_quota: 0 });
                }
                const adoptedGb = bytesToGib(drift.garageSizeBytes);
                await buckets.updateBucket(garage, {
                  id: pbBucket.garage_bucket_id,
                  quotas: {
                    maxSize:
                      drift.garageSizeBytes > 0 ? drift.garageSizeBytes : null,
                    maxObjects: maxObjectsForQuotaGib(adoptedGb),
                  },
                });
              }
              wrote = true;
            }
          } else {
            const quotaGb = pbBucket.quota_gb ?? 0;
            await buckets.updateBucket(garage, {
              id: pbBucket.garage_bucket_id,
              quotas: {
                maxSize: quotaGb > 0 ? gibToBytes(quotaGb) : null,
                // Effective, not derived: this is the direction that re-applies
                // an admin's explicit override after a half-applied PATCH.
                maxObjects: effectiveMaxObjectsFor(pbBucket),
              },
            });
            wrote = true;
          }

          if (refusal) {
            failed++;
            errors.push(`${pbBucket.id}: size quota not adopted — ${refusal}`);
            return;
          }
          if (wrote) synced++;
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
