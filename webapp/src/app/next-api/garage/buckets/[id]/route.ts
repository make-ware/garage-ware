import { z } from 'zod';
import { GarageClient, buckets, cluster } from '@/lib/garage';
import { formatStorage } from '@/lib/format';
import { getUserGrantedGb } from '@/lib/storage/claims';
import { gibToBytes } from '@/lib/storage/units';
import { effectiveMaxObjectsFor } from '@/lib/storage/object-quota';
import {
  syncQuotaToPbBackground,
  syncUsageToPbBackground,
} from '@/lib/storage/quota-sync';
import { HttpError, errorResponse } from '@/lib/auth/server';
import { loadOwnedBucket } from '@/lib/auth/ownership';

export const dynamic = 'force-dynamic';

const PatchBody = z.object({
  quota_gb: z.number().min(0).optional(),
  /** Explicit object cap. 0 clears the override and restores the derivation. */
  object_quota: z.number().int().min(0).optional(),
  website: z
    .object({
      enabled: z.boolean(),
      indexDocument: z.string().optional(),
      errorDocument: z.string().optional(),
    })
    .optional(),
});

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const { pb, record } = await loadOwnedBucket(req, id);
    const garage = GarageClient.fromEnv();
    const info = await buckets.getBucketInfo(garage, {
      id: record.garage_bucket_id,
    });
    syncQuotaToPbBackground(pb, record, info);
    syncUsageToPbBackground(pb, record, info);
    return Response.json({ record, garage: info });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const body = PatchBody.parse(await req.json());
    const { pb, record, bucketMutator } = await loadOwnedBucket(req, id);
    const garage = GarageClient.fromEnv();

    const currentGb = record.quota_gb ?? 0;
    const currentObjectQuota = record.object_quota ?? 0;
    const nextGb = body.quota_gb ?? currentGb;
    const nextObjectQuota = body.object_quota ?? currentObjectQuota;
    const sizeChanged =
      body.quota_gb !== undefined && body.quota_gb !== currentGb;
    const objectsChanged =
      body.object_quota !== undefined &&
      body.object_quota !== currentObjectQuota;

    if (sizeChanged || objectsChanged) {
      // Only the SIZE axis draws on the owner's storage claim. An object cap is
      // not a claimed resource — there is no object ledger, no per-user object
      // grant, and `allocated_gb` tracks `quota_gb` alone — so an object-only
      // edit deliberately skips the layout fetch and the two balance reads.
      if (sizeChanged) {
        const layout = await cluster.getLayout(garage);
        const granted = await getUserGrantedGb(pb, record.user, {
          onlyPresent: true,
          layout,
        });
        const allocated = await bucketMutator.sumAllocatedGb(
          record.user,
          record.id
        );
        if (allocated + nextGb > granted) {
          throw new HttpError(
            400,
            `Quota exceeds the user's storage claim (allocated ${formatStorage(allocated)} + requested ${formatStorage(nextGb)} > granted ${formatStorage(granted)})`
          );
        }
      }

      // Garage's `quotas` object REPLACES both axes — `updateBucket` spreads the
      // body wholesale — so `maxSize` has to be re-sent from the record's
      // current value on an object-only edit, or the size quota is silently
      // dropped. Likewise `maxObjects` goes through `effectiveMaxObjectsFor`, so
      // a size change never recomputes away an admin's explicit override.
      await buckets.updateBucket(garage, {
        id: record.garage_bucket_id,
        quotas: {
          maxSize: nextGb > 0 ? gibToBytes(nextGb) : null,
          maxObjects: effectiveMaxObjectsFor({
            quota_gb: nextGb,
            object_quota: nextObjectQuota,
          }),
        },
      });
      await pb.collection('Buckets').update(record.id, {
        ...(sizeChanged && { quota_gb: nextGb }),
        ...(objectsChanged && { object_quota: nextObjectQuota }),
      });
    }

    if (body.website) {
      await buckets.updateBucket(garage, {
        id: record.garage_bucket_id,
        websiteAccess: body.website,
      });
    }

    const updated = await bucketMutator.getById(record.id);
    return Response.json({ record: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const { pb, record } = await loadOwnedBucket(req, id);
    const garage = GarageClient.fromEnv();
    await buckets.deleteBucket(garage, record.garage_bucket_id);
    await pb.collection('Buckets').delete(record.id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
