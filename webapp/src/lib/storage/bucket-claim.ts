/**
 * Deciding whether somebody may claim a bucket.
 *
 * Deliberately **not** `server-only` and deliberately typed *structurally*, so
 * it imports nothing from `lib/garage/*` — the same arrangement as
 * `buildNodeNameMap` in `lib/node-label.ts`. The point is that the rule is one
 * pure function a test can drive across every shape Garage can return, rather
 * than a condition buried in a route handler that only an end-to-end test
 * reaches.
 */

/** One entry of `GetBucketInfo.keys[]`, narrowed to what the rule reads. */
export interface BucketKeyGrant {
  accessKeyId: string;
  permissions: {
    read?: boolean;
    write?: boolean;
    owner?: boolean;
  };
}

/**
 * Which of the caller's keys proves they own this bucket, if any.
 *
 * Returns the proving access key id — useful for the audit line — or `null`.
 *
 * **`owner` exactly, not read/write.** Garage has its own notion of bucket
 * ownership and this borrows it rather than inventing a second one. A key with
 * read/write holds a grant somebody gave it, which on a shared bucket is not
 * the same as owning the thing; treating it as proof would let a read/write
 * grantee take the ownership record from under the person who granted it.
 *
 * **`permissions.owner` is optional in Garage's schema** — all three flags are,
 * so a key with no permissions may omit them rather than send `false`. The
 * strict `=== true` is what stops `undefined` being read as anything but "no".
 *
 * The caller's key list is passed in rather than looked up here, because it has
 * to come from *their own* PocketBase client: `AccessKeys` is self-or-admin, so
 * a self-scoped read returns exactly the keys they have already proven, whereas
 * a superuser read would return everyone's and the match would silently become
 * "does anyone own this bucket".
 */
export function ownedBucketKeyFor(
  bucketKeys: readonly BucketKeyGrant[] | undefined,
  callerKeyIds: readonly string[]
): string | null {
  if (!bucketKeys || bucketKeys.length === 0) return null;
  const mine = new Set(callerKeyIds);
  for (const grant of bucketKeys) {
    if (grant.permissions?.owner === true && mine.has(grant.accessKeyId)) {
      return grant.accessKeyId;
    }
  }
  return null;
}
