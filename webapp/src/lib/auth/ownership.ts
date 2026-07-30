import 'server-only';
import { AccessKeyMutator, BucketMutator } from '@garage-ware/shared/mutators';
import type { AccessKey, Bucket, User } from '@garage-ware/shared';
import type { TypedPocketBase } from '@/lib/types';
import { HttpError, getServerUser, isUserAdmin } from './server';

/**
 * Guards for any Route Handler that issues a Garage write on behalf of a
 * specific user. The Garage admin token is unrestricted, so PocketBase
 * ownership is the only thing protecting one user's bucket/key from another's
 * — every write path must run through one of these helpers.
 */

interface OwnedContext<TRecord> {
  pb: TypedPocketBase;
  user: User & { id: string };
  isAdmin: boolean;
  record: TRecord;
}

export async function loadOwnedBucket(
  req: Request,
  pbId: string
): Promise<OwnedContext<Bucket> & { bucketMutator: BucketMutator }> {
  const { pb, user } = await getServerUser(req);
  const bucketMutator = new BucketMutator(pb);
  const record = await bucketMutator.getById(pbId);
  if (!record) throw new HttpError(404, 'Bucket not found');
  let isAdmin = false;
  if (record.user !== user.id) {
    isAdmin = await isUserAdmin(pb, user.id);
    if (!isAdmin) throw new HttpError(403, 'Not your bucket');
  }
  return { pb, user, record, isAdmin, bucketMutator };
}

export async function loadOwnedKey(
  req: Request,
  pbId: string
): Promise<OwnedContext<AccessKey> & { accessKeyMutator: AccessKeyMutator }> {
  const { pb, user } = await getServerUser(req);
  const accessKeyMutator = new AccessKeyMutator(pb);
  const record = await accessKeyMutator.getById(pbId);
  if (!record) throw new HttpError(404, 'Access key not found');
  let isAdmin = false;
  if (record.user !== user.id) {
    isAdmin = await isUserAdmin(pb, user.id);
    if (!isAdmin) throw new HttpError(403, 'Not your key');
  }
  return { pb, user, record, isAdmin, accessKeyMutator };
}

/**
 * Assert ownership of a Bucket already loaded by another lookup. Pass the
 * caller's previously-resolved `isAdmin` flag to avoid a second Admins query.
 */
export async function assertBucketOwner(
  pb: TypedPocketBase,
  bucket: Bucket,
  userId: string,
  isAdmin?: boolean
): Promise<void> {
  if (bucket.user === userId) return;
  const admin = isAdmin ?? (await isUserAdmin(pb, userId));
  if (!admin) throw new HttpError(403, 'Not your bucket');
}

export async function assertKeyOwner(
  pb: TypedPocketBase,
  key: AccessKey,
  userId: string,
  isAdmin?: boolean
): Promise<void> {
  if (key.user === userId) return;
  const admin = isAdmin ?? (await isUserAdmin(pb, userId));
  if (!admin) throw new HttpError(403, 'Not your key');
}
