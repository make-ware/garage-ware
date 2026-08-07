import 'server-only';
import { StorageTransferMutator } from '@garage-ware/shared/mutators';
import type { ClusterLayout } from '@/lib/garage';
import { computeSummaryFromBalances } from '@/lib/storage/ledger-math';
import { getAllBalances, getUserBalances } from '@/lib/storage/balances';
import type { StorageSummary, TypedPocketBase } from '@/lib/types';

export type { StorageSummary };

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
