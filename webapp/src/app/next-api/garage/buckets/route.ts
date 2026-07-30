import { z } from 'zod';
import { BucketMutator } from '@garage-ware/shared/mutators';
import { BucketInputSchema } from '@garage-ware/shared/schema';
import type { Bucket } from '@garage-ware/shared';
import { GarageClient, buckets, cluster } from '@/lib/garage';
import { formatStorage } from '@/lib/format';
import { getUserGrantedGb } from '@/lib/storage/claims';
import { gibToBytes } from '@/lib/storage/units';
import { maxObjectsForQuotaGib } from '@/lib/storage/object-quota';
import {
  syncQuotaToPbBackground,
  syncUsageToPbBackground,
} from '@/lib/storage/quota-sync';
import type { BucketWithUsage } from '@/lib/types';
import {
  HttpError,
  errorResponse,
  getServerUser,
  isUserAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const CreateBody = BucketInputSchema.pick({ name: true, quota_gb: true });

async function enrichWithUsage(
  items: Bucket[],
  pb: import('@/lib/types').TypedPocketBase
): Promise<BucketWithUsage[]> {
  if (items.length === 0) return items;
  const garage = GarageClient.fromEnv();
  const settled = await Promise.allSettled(
    items.map((b) => buckets.getBucketInfo(garage, { id: b.garage_bucket_id }))
  );
  return items.map((item, i) => {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      syncQuotaToPbBackground(pb, item, result.value);
      syncUsageToPbBackground(pb, item, result.value);
      return {
        ...item,
        bytes: result.value.bytes ?? 0,
        objects: result.value.objects ?? 0,
        maxObjects: result.value.quotas?.maxObjects ?? null,
      };
    }
    console.error(
      '[buckets] usage fetch failed:',
      item.garage_bucket_id,
      result.reason
    );
    return item;
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
          items: await enrichWithUsage(result.items, pb),
        });
      }
      const result = await bucketMutator.listByUser(requestedUserId!);
      return Response.json({ items: await enrichWithUsage(result.items, pb) });
    }

    const result = await bucketMutator.listByUser(user.id);
    return Response.json({ items: await enrichWithUsage(result.items, pb) });
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
