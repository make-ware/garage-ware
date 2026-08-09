import { z } from 'zod';
import { BucketMutator } from '@garage-ware/shared/mutators';
import { BucketInputSchema } from '@garage-ware/shared/schema';
import type { Bucket } from '@garage-ware/shared';
import { GarageClient, buckets, cluster } from '@/lib/garage';
import { formatStorage } from '@/lib/format';
import { getUserGrantedGb } from '@/lib/storage/claims';
import { gibToBytes } from '@/lib/storage/units';
import { maxObjectsForQuotaGib } from '@/lib/storage/object-quota';
import { refreshBucketsFromGarageBackground } from '@/lib/storage/quota-sync';
import type { BucketWithUsage, TypedPocketBase } from '@/lib/types';
import {
  HttpError,
  errorResponse,
  getServerUser,
  isUserAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const CreateBody = BucketInputSchema.pick({ name: true, quota_gb: true });

/**
 * Answer from the usage columns already on each Bucket row, and refresh them
 * behind the response.
 *
 * These columns have always existed — `bytes`, `objects`, `max_objects`,
 * `usage_updated_at` — but this handler used to write them and then not read
 * them, awaiting one `GetBucketInfo` per bucket before it could answer. Reading
 * what is already there makes the steady-state load zero Garage calls deep,
 * and the background pass keeps the numbers a page-load old, which is all they
 * ever were.
 *
 * The one case that still blocks is a bucket with no `usage_updated_at` at all:
 * nothing has ever synced it, so there is no cached value to serve, and an
 * imported bucket can hold real data on its very first render. Reporting zero
 * there would be a wrong answer rather than a slightly old one. Failures fall
 * back to the bare record, exactly as before.
 */
async function withUsage(
  items: Bucket[],
  pb: TypedPocketBase
): Promise<BucketWithUsage[]> {
  if (items.length === 0) return items;

  const unsynced = items.filter((b) => !b.usage_updated_at);
  const live = new Map<string, BucketWithUsage>();
  if (unsynced.length > 0) {
    const garage = GarageClient.fromEnv();
    const settled = await Promise.allSettled(
      unsynced.map((b) =>
        buckets.getBucketInfo(garage, { id: b.garage_bucket_id })
      )
    );
    unsynced.forEach((item, i) => {
      const result = settled[i];
      if (result.status !== 'fulfilled') {
        console.error(
          '[buckets] usage fetch failed:',
          item.garage_bucket_id,
          result.reason
        );
        return;
      }
      live.set(item.id, {
        ...item,
        bytes: result.value.bytes ?? 0,
        objects: result.value.objects ?? 0,
        maxObjects: result.value.quotas?.maxObjects ?? null,
      });
    });
  }

  // Unconditional: the daily bucket-usage-alerts cron is DB-only and depends
  // on dashboard reads to keep these columns fresh, so every GET still
  // refreshes them — just not before answering.
  refreshBucketsFromGarageBackground(pb, items);

  return items.map((item) => {
    const fetched = live.get(item.id);
    if (fetched) return fetched;
    if (!item.usage_updated_at) return item;
    return {
      ...item,
      bytes: item.bytes ?? 0,
      objects: item.objects ?? 0,
      // The column stores 0 for "no cap"; the API contract is null.
      maxObjects: item.max_objects ? item.max_objects : null,
    };
  });
}

export async function GET(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const url = new URL(req.url);
    const requestedUserId = url.searchParams.get('userId');
    const all = url.searchParams.get('all') === 'true';

    const bucketMutator = new BucketMutator(pb);

    if (all || (requestedUserId && requestedUserId !== user.id)) {
      const admin = await isUserAdmin(pb, user.id);
      if (!admin) throw new HttpError(403, 'Admin privileges required');
      if (all) {
        const result = await bucketMutator.getList(
          1,
          200,
          undefined,
          undefined,
          ['user']
        );
        return Response.json({
          items: await withUsage(result.items, pb),
        });
      }
      const result = await bucketMutator.listByUser(requestedUserId!);
      return Response.json({ items: await withUsage(result.items, pb) });
    }

    const result = await bucketMutator.listByUser(user.id);
    return Response.json({ items: await withUsage(result.items, pb) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const body = CreateBody.parse(await req.json());

    const bucketMutator = new BucketMutator(pb);
    const garage = GarageClient.fromEnv();
    const layout = await cluster.getLayout(garage);
    const granted = await getUserGrantedGb(pb, user.id, {
      onlyPresent: true,
      layout,
    });
    const allocated = await bucketMutator.sumAllocatedGb(user.id);
    if (allocated + body.quota_gb > granted) {
      throw new HttpError(
        400,
        `Quota exceeds your storage claim (allocated ${formatStorage(allocated)} + requested ${formatStorage(body.quota_gb)} > granted ${formatStorage(granted)})`
      );
    }

    const created = await buckets.createBucket(garage, {
      globalAlias: body.name,
    });
    if (body.quota_gb > 0) {
      await buckets.updateBucket(garage, {
        id: created.id,
        quotas: {
          maxSize: gibToBytes(body.quota_gb),
          maxObjects: maxObjectsForQuotaGib(body.quota_gb),
        },
      });
    }

    let pbRecord;
    try {
      pbRecord = await pb.collection('Buckets').create({
        user: user.id,
        garage_bucket_id: created.id,
        name: body.name,
        quota_gb: body.quota_gb,
      });
    } catch (err) {
      try {
        await buckets.deleteBucket(garage, created.id);
      } catch (rollbackErr) {
        console.error('[buckets] rollback delete failed:', rollbackErr);
      }
      throw err;
    }

    return Response.json({ record: pbRecord, garage_bucket_id: created.id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
