import { z } from 'zod';
import { BucketMutator } from '@garage-ware/shared/mutators';
import { GarageClient, permissions } from '@/lib/garage';
import { HttpError, errorResponse } from '@/lib/auth/server';
import { assertBucketOwner, loadOwnedKey } from '@/lib/auth/ownership';

export const dynamic = 'force-dynamic';

const PermissionsBody = z.object({
  bucket_id: z.string().min(1),
  action: z.enum(['allow', 'deny']),
  permissions: z.object({
    read: z.boolean().optional(),
    write: z.boolean().optional(),
    owner: z.boolean().optional(),
  }),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const body = PermissionsBody.parse(await req.json());

    const {
      pb,
      user,
      isAdmin,
      record: accessKey,
    } = await loadOwnedKey(req, id);

    const bucket = await new BucketMutator(pb).getById(body.bucket_id);
    if (!bucket) throw new HttpError(404, 'Bucket not found');
    await assertBucketOwner(pb, bucket, user.id, isAdmin);

    const garage = GarageClient.fromEnv();
    const op =
      body.action === 'allow'
        ? permissions.allowBucketKey
        : permissions.denyBucketKey;
    await op(garage, {
      bucketId: bucket.garage_bucket_id,
      accessKeyId: accessKey.garage_key_id,
      permissions: body.permissions,
    });
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
