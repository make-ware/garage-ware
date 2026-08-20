import 'server-only';
import {
  AccessKeyMutator,
  BucketMutator,
  NodeOwnerMutator,
} from '@garage-ware/shared/mutators';
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

/**
 * Assert that `userId` owns the Garage node `nodeId`, or is an admin.
 *
 * Unlike buckets and keys there is no record to hand in: ownership lives in its
 * own collection, and the lookup runs through the **caller's own** `pb`. That is
 * deliberate and needs no superuser auth — the NodeOwners listRule is
 * `user = @request.auth.id || admin`, so a lookup by node id returns a row iff
 * the caller owns that node. The same self-scoped-lookup trick `isUserAdmin`
 * plays against Admins.
 *
 * A null result therefore means "not yours", which is not the same as
 * "unowned". Nothing here should be read as evidence that a node is free to
 * claim; the UNIQUE index on `node_id` is the authority on that.
 *
 * Returns whether the caller passed as an admin, so a handler that already
 * needs to know can avoid a second Admins query.
 *
 * **`FEATURE_NODE_CLAIMS` is deliberately not read here.** That flag gates one
 * door — a user claiming a node for themselves by its full id, and the release
 * that undoes it — and both live in `/next-api/garage/nodes/owners`. Gating the
 * lookup here instead made every existing row inert the moment the flag went
 * off, so an owner an admin had just assigned on `/admin/nodes` could not grant
 * a single GB from their own machine. Who may append a row is a property of the
 * row, not of the deployment's appetite for self-service.
 */
export async function assertNodeOwner(
  pb: TypedPocketBase,
  nodeId: string,
  userId: string,
  isAdmin?: boolean
): Promise<{ isAdmin: boolean }> {
  if (isAdmin) return { isAdmin: true };

  const owners = new NodeOwnerMutator(pb);
  const record = await owners.findByNode(nodeId);
  if (record && record.user === userId) return { isAdmin: false };

  const admin = await isUserAdmin(pb, userId);
  if (!admin) throw new HttpError(403, 'You do not own this node');
  return { isAdmin: true };
}
