import { z } from 'zod';
import { GarageClient, buckets, cluster } from '@/lib/garage';
import { formatStorage } from '@/lib/format';
import { getUserGrantedGb } from '@/lib/storage/claims';
import { gibToBytes } from '@/lib/storage/units';
import { maxObjectsForQuotaGib } from '@/lib/storage/object-quota';
import {
  syncQuotaToPbBackground,
  syncUsageToPbBackground,
} from '@/lib/storage/quota-sync';
import { HttpError, errorResponse } from '@/lib/auth/server';
import { loadOwnedBucket } from '@/lib/auth/ownership';

export const dynamic = 'force-dynamic';

const PatchBody = z.object({
  quota_gb: z.number().min(0).optional(),
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

    if (body.quota_gb !== undefined && body.quota_gb !== record.quota_gb) {
      // Re-validate the user's total claim, excluding this bucket's current allocation
      const layout = await cluster.getLayout(garage);
      const granted = await getUserGrantedGb(pb, record.user, {
        onlyPresent: true,
        layout,
      });
      const allocated = await bucketMutator.sumAllocatedGb(
        record.user,
        record.id
      );
      if (allocated + body.quota_gb > granted) {
        throw new HttpError(
          400,
          `Quota exceeds the user's storage claim (allocated ${formatStorage(allocated)} + requested ${formatStorage(body.quota_gb)} > granted ${formatStorage(granted)})`
        );
      }

      await buckets.updateBucket(garage, {
        id: record.garage_bucket_id,
        quotas: {
          maxSize: body.quota_gb > 0 ? gibToBytes(body.quota_gb) : null,
          maxObjects: maxObjectsForQuotaGib(body.quota_gb),
        },
      });
      await pb
        .collection('Buckets')
        .update(record.id, { quota_gb: body.quota_gb });
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
