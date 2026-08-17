import { z } from 'zod';
import { BucketMutator } from '@garage-ware/shared/mutators';
import { GarageClient, buckets, cluster } from '@/lib/garage';
import { formatStorage } from '@/lib/format';
import { getUserPosition } from '@/lib/storage/summary';
import { bytesToGib } from '@/lib/storage/units';
import {
  HttpError,
  errorResponse,
  getPbAsSuperuser,
  requireAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const ImportBody = z.object({
  garage_bucket_id: z.string().min(1).max(128),
  user_id: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const { pb } = await requireAdmin(req);
    const body = ImportBody.parse(await req.json());

    const bucketMutator = new BucketMutator(pb);
    const existing = await bucketMutator.findByGarageId(body.garage_bucket_id);
    if (existing) {
      throw new HttpError(
        409,
        `Bucket ${body.garage_bucket_id} is already allocated to a user`
      );
    }

    const garage = GarageClient.fromEnv();
    const [info, layout] = await Promise.all([
      buckets.getBucketInfo(garage, { id: body.garage_bucket_id }),
      cluster.getLayout(garage),
    ]);
    const quotaGb = bytesToGib(info.quotas?.maxSize ?? 0);

    // The caller is an admin, so their own client can read the target user's
    // balance rows — both collections are scoped `user = self || admin`.
    const { netGrantedGb: claimGb, allocatedGb } = await getUserPosition(
      pb,
      body.user_id,
      layout
    );
    if (allocatedGb + quotaGb > claimGb) {
      throw new HttpError(
        400,
        `Bucket quota exceeds target user's storage claim (allocated ${formatStorage(allocatedGb)} + bucket ${formatStorage(quotaGb)} > granted ${formatStorage(claimGb)})`
      );
    }

    const name = info.globalAliases[0] ?? info.id;

    const writePb = await getPbAsSuperuser();
    const record = await writePb.collection('Buckets').create({
      user: body.user_id,
      garage_bucket_id: info.id,
      name,
      quota_gb: quotaGb,
    });

    return Response.json({ record });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
