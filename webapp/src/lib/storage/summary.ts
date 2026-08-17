import 'server-only';
import { StorageTransferMutator } from '@garage-ware/shared/mutators';
import type { ClusterLayout } from '@/lib/garage';
import {
  computeSummaryFromBalances,
  type ComputedStorageSummary,
} from '@/lib/storage/ledger-math';
import { getAllBalances, getUserBalances } from '@/lib/storage/balances';
import type { StorageSummary, TypedPocketBase } from '@/lib/types';

export type { StorageSummary };

/**
 * One user's position, in one query, without the transfer rows.
 *
 * **This is the call a guard should reach for.** Every check of the per-user
 * invariant needs both halves of `sum(bucket.quota_gb) <= netGranted`, and
 * taking them from one read makes them provably consistent. They used to come
 * from two places — `getUserGrantedGb` for the grant and
 * `BucketMutator.sumAllocatedGb` for the allocation — and the second read a
 * single 1000-row page of a collection that only grows, so on a busy account it
 * silently under-reported and the guard waved the write through.
 *
 * `getUserStorageSummary` is this plus two queries for the individual handoffs,
 * which only the dashboard's transfer table wants.
 *
 * The numbers are the hook-maintained cache rather than the ledgers themselves;
 * that is the whole balances design, and the nightly `storage-balance-rebuild`
 * is what makes drift loud rather than permanent.
 *
 * `pb` must be able to read the target user's balance rows. Both collections
 * are scoped `user = self || admin`, so the caller's own client suffices when
 * they are the subject or an admin. Unlike `assertClaimDeltaAllowed` this never
 * reads *other* users' rows, so it needs no superuser client of its own.
 */
export async function getUserPosition(
  pb: TypedPocketBase,
  userId: string,
  layout?: ClusterLayout
): Promise<ComputedStorageSummary> {
  const { nodeBalances, userBalance } = await getUserBalances(pb, userId);
  return computeSummaryFromBalances(nodeBalances, userBalance, layout);
}

/**
 * A user's complete storage position, read from the materialized balances.
 *
 * The numbers come from StorageNodeBalances / StorageUserBalances rather than
 * from the ledgers themselves — the ledgers only grow, and summing them meant
 * reading one page of an unbounded collection. The layout filter is still
 * applied here, at read time, because that is the only place the live cluster
 * layout is available.
 *
 * Transfer *rows* are still listed for the dashboard's "Received transfers"
 * table; the position's numbers do not depend on them.
 */
export async function getUserStorageSummary(
  pb: TypedPocketBase,
  userId: string,
  layout?: ClusterLayout
): Promise<StorageSummary> {
  const transferMutator = new StorageTransferMutator(pb);

  const [{ nodeBalances, userBalance }, sentResult, receivedResult] =
    await Promise.all([
      getUserBalances(pb, userId),
      transferMutator.listSentByUser(userId),
      transferMutator.listReceivedByUser(userId),
    ]);

  return {
    ...computeSummaryFromBalances(nodeBalances, userBalance, layout),
    sentTransfers: sentResult.items,
    receivedTransfers: receivedResult.items,
  };
}

/**
 * The same position for many users at once, in a fixed number of queries.
 *
 * Reads every balance row and buckets it in memory, then runs the identical
 * `computeSummaryFromBalances` per user so the two paths cannot drift. Every
 * requested id gets an entry, including users with no rows at all, so callers
 * can index the map without a null check.
 *
 * Transfer rows are deliberately not fetched here — a list view wants the
 * totals, not every handoff. `sentTransfers` / `receivedTransfers` come back
 * empty; use `getUserStorageSummary` when the rows are needed.
 */
export async function getStorageSummariesForUsers(
  pb: TypedPocketBase,
  userIds: readonly string[],
  layout?: ClusterLayout
): Promise<Map<string, StorageSummary>> {
  const summaries = new Map<string, StorageSummary>();
  if (userIds.length === 0) return summaries;

  const { nodeBalancesByUser, userBalances } = await getAllBalances(pb);

  for (const userId of userIds) {
    summaries.set(
      userId,
      computeSummaryFromBalances(
        nodeBalancesByUser.get(userId) ?? [],
        userBalances.get(userId) ?? null,
        layout
      )
    );
  }

  return summaries;
}
