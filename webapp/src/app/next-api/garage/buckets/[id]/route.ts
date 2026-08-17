import { z } from 'zod';
import {
  GarageClient,
  GarageNotFoundError,
  buckets,
  cluster,
} from '@/lib/garage';
import { formatBytes, formatStorage } from '@/lib/format';
import {
  describeBucketEmptiness,
  type BucketEmptiness,
} from '@/lib/storage/bucket-emptiness';
import { allocatedExcluding } from '@/lib/storage/ledger-math';
import { getUserPosition } from '@/lib/storage/summary';
import { gibToBytes } from '@/lib/storage/units';
import { effectiveMaxObjectsFor } from '@/lib/storage/object-quota';
import {
  syncQuotaToPbBackground,
  syncUsageToPbBackground,
} from '@/lib/storage/quota-sync';
import { HttpError, errorResponse, getPbAsSuperuser } from '@/lib/auth/server';
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
        const { netGrantedGb: granted, allocatedGb } = await getUserPosition(
          pb,
          record.user,
          layout
        );
        // The balance counts this bucket's current quota, and `nextGb` replaces
        // it rather than adding to it — see `allocatedExcluding`.
        const allocated = allocatedExcluding(allocatedGb, currentGb);
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
      const writePb = await getPbAsSuperuser();
      await writePb.collection('Buckets').update(record.id, {
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
    // No `pb`: the delete is a superuser write, and the ownership check is
    // loadOwnedBucket's own read.
    const { record } = await loadOwnedBucket(req, id);
    const garage = GarageClient.fromEnv();

    // Pre-flight, so a refusal can name what is in the bucket rather than
    // relaying Garage's bare "Bucket is not empty". Garage enforces the rule
    // regardless — these two reads are not atomic, and an upload landing
    // between them comes back as a `not_empty` 409 from the delete itself.
    //
    // A bucket Garage no longer knows about is NOT a reason to stop: that is
    // exactly the stranded row this delete needs to be able to clear, so the
    // guard is skipped and `deleteBucket` treats the 404 as success.
    let info: Awaited<ReturnType<typeof buckets.getBucketInfo>> | null = null;
    try {
      info = await buckets.getBucketInfo(garage, {
        id: record.garage_bucket_id,
      });
    } catch (err) {
      if (!(err instanceof GarageNotFoundError)) throw err;
    }

    if (info) {
      const contents = describeBucketEmptiness(info);
      if (!contents.empty) {
        throw new HttpError(409, describeRefusal(record.name, contents));
      }
    }

    await buckets.deleteBucket(garage, record.garage_bucket_id);
    const writePb = await getPbAsSuperuser();
    await writePb.collection('Buckets').delete(record.id);
    console.log(`[buckets] ${record.garage_bucket_id} deleted by its owner`);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Why a bucket cannot be deleted, in words the owner can act on.
 *
 * Names the count and the size, because "not empty" alone leaves someone
 * hunting for what is in there. Points at the Connect page rather than the file
 * browser on purpose: the in-app browser can list, upload and download but not
 * delete, so emptying genuinely has to happen in the user's own S3 client.
 */
function describeRefusal(name: string, contents: BucketEmptiness): string {
  if (contents.unknown) {
    return `Garage did not report what ${name} contains, so it will not be deleted. Try again shortly.`;
  }
  const parts: string[] = [];
  if (contents.objects) {
    parts.push(
      `${contents.objects.toLocaleString()} object${contents.objects === 1 ? '' : 's'}`
    );
  }
  if (contents.bytes) parts.push(formatBytes(contents.bytes));
  if (contents.unfinishedUploads) {
    parts.push(`${contents.unfinishedUploads} unfinished upload(s)`);
  }
  const held = parts.length > 0 ? parts.join(', ') : 'data';
  return `${name} still holds ${held}. Empty it with your S3 client first — see the bucket's Connect page for credentials and endpoint.`;
}
