import 'server-only';
import type { ListResult } from 'pocketbase';
import {
  BucketMutator,
  StorageClaimMutator,
  StorageTransferMutator,
} from '@garage-ware/shared/mutators';
import type {
  Bucket,
  StorageClaim,
  StorageTransfer,
} from '@garage-ware/shared';
import type { ClusterLayout } from '@/lib/garage';
import { computeStorageSummary } from '@/lib/storage/ledger-math';
import type { StorageSummary, TypedPocketBase } from '@/lib/types';

export type { StorageSummary };

/** Upper bound on rows pulled per collection by the bulk path. */
const BULK_PAGE_SIZE = 500;

/**
 * Drain every page of a list query.
 *
 * The per-user helpers cap at a single page (200–1000 rows), which quietly
 * under-counts once a ledger outgrows them. The bulk path reads whole
 * collections, so it cannot afford to guess — it pages until PocketBase says
 * there is nothing left.
 */
async function fetchAllPages<T>(
  fetchPage: (page: number, perPage: number) => Promise<ListResult<T>>
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const result = await fetchPage(page, BULK_PAGE_SIZE);
    items.push(...result.items);
    totalPages = result.totalPages || 1;
    page += 1;
  } while (page <= totalPages);
  return items;
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/**
 * Compute a complete storage position for a user in one place.
 * When layout is provided, claimsGb filters out decommissioned nodes
 * (same conservative accounting used by bucket-quota validators).
 *
 * Fetching lives here; the arithmetic lives in `computeStorageSummary` so the
 * bulk path below and the client both run the identical formula.
 */
export async function getUserStorageSummary(
  pb: TypedPocketBase,
  userId: string,
  layout?: ClusterLayout
): Promise<StorageSummary> {
  const claimMutator = new StorageClaimMutator(pb);
  const transferMutator = new StorageTransferMutator(pb);
  const bucketMutator = new BucketMutator(pb);

  const [claimsResult, sentResult, receivedResult, allocatedGb] =
    await Promise.all([
      claimMutator.listByUser(userId),
      transferMutator.listSentByUser(userId),
      transferMutator.listReceivedByUser(userId),
      bucketMutator.sumAllocatedGb(userId),
    ]);

  return computeStorageSummary(
    claimsResult.items,
    sentResult.items,
    receivedResult.items,
    allocatedGb,
    layout
  );
}

/**
 * The same position as {@link getUserStorageSummary}, for many users at once.
 *
 * The admin user list needs every user's figures on one screen. Calling the
 * single-user helper in a loop is four queries per user; this reads each
 * collection once and buckets the rows in memory, then runs the identical
 * `computeStorageSummary` per user so the two paths cannot drift.
 *
 * Every requested id gets an entry, including users with no rows at all —
 * callers can index the map without a null check.
 */
export async function getStorageSummariesForUsers(
  pb: TypedPocketBase,
  userIds: readonly string[],
  layout?: ClusterLayout
): Promise<Map<string, StorageSummary>> {
  const summaries = new Map<string, StorageSummary>();
  if (userIds.length === 0) return summaries;

  const claimMutator = new StorageClaimMutator(pb);
  const transferMutator = new StorageTransferMutator(pb);
  const bucketMutator = new BucketMutator(pb);

  const [allClaims, allTransfers, allBuckets] = await Promise.all([
    fetchAllPages<StorageClaim>((page, perPage) =>
      claimMutator.getList(page, perPage)
    ),
    fetchAllPages<StorageTransfer>((page, perPage) =>
      transferMutator.getList(page, perPage)
    ),
    fetchAllPages<Bucket>((page, perPage) =>
      bucketMutator.getList(page, perPage)
    ),
  ]);

  const claimsByUser = new Map<string, StorageClaim[]>();
  for (const claim of allClaims) pushInto(claimsByUser, claim.user, claim);

  // One pass over transfers fills both sides — a row is "sent" for its sender
  // and "received" for its recipient.
  const sentByUser = new Map<string, StorageTransfer[]>();
  const receivedByUser = new Map<string, StorageTransfer[]>();
  for (const transfer of allTransfers) {
    pushInto(sentByUser, transfer.from_user, transfer);
    pushInto(receivedByUser, transfer.to_user, transfer);
  }

  const allocatedByUser = new Map<string, number>();
  for (const bucket of allBuckets) {
    allocatedByUser.set(
      bucket.user,
      (allocatedByUser.get(bucket.user) ?? 0) + (Number(bucket.quota_gb) || 0)
    );
  }

  for (const userId of userIds) {
    summaries.set(
      userId,
      computeStorageSummary(
        claimsByUser.get(userId) ?? [],
        sentByUser.get(userId) ?? [],
        receivedByUser.get(userId) ?? [],
        allocatedByUser.get(userId) ?? 0,
        layout
      )
    );
  }

  return summaries;
}
