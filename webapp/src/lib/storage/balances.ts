import 'server-only';
import type { ListResult } from 'pocketbase';
import {
  StorageNodeBalanceMutator,
  StorageUserBalanceMutator,
} from '@garage-ware/shared/mutators';
import type {
  StorageNodeBalance,
  StorageUserBalance,
} from '@garage-ware/shared';
import type { TypedPocketBase } from '@/lib/types';

/**
 * Reads of the materialized balance roll-ups.
 *
 * The rows are written only by the PocketBase hooks in pb_hooks/main.pb.js;
 * nothing here writes. What these functions replace is paging the ledgers:
 * every per-user sum used to read a single page of an append-only collection,
 * which under-counts silently once it outgrows the page.
 *
 * Balances are bounded by (users x nodes), so a generous page size genuinely
 * covers them — but the bulk reads page to exhaustion anyway, because "surely
 * it fits" is the assumption that caused the original bug.
 */

const PAGE_SIZE = 500;

async function fetchAllPages<T>(
  fetchPage: (page: number, perPage: number) => Promise<ListResult<T>>
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const result = await fetchPage(page, PAGE_SIZE);
    items.push(...result.items);
    totalPages = result.totalPages || 1;
    page += 1;
  } while (page <= totalPages);
  return items;
}

export interface UserBalances {
  nodeBalances: StorageNodeBalance[];
  /** Null when the user has no row yet — treat as a zeroed position. */
  userBalance: StorageUserBalance | null;
}

/** One user's balance rows. */
export async function getUserBalances(
  pb: TypedPocketBase,
  userId: string
): Promise<UserBalances> {
  const nodes = new StorageNodeBalanceMutator(pb);
  const users = new StorageUserBalanceMutator(pb);
  const [nodeResult, userBalance] = await Promise.all([
    nodes.listByUser(userId),
    users.findByUser(userId),
  ]);
  return { nodeBalances: nodeResult.items, userBalance };
}

/**
 * Total claimed on one node across every user — the per-node capacity check.
 * Replaces `StorageClaimMutator.sumByNode`, which read one page of the ledger.
 */
export async function getNodeClaimedGb(
  pb: TypedPocketBase,
  nodeId: string
): Promise<number> {
  const nodes = new StorageNodeBalanceMutator(pb);
  const balances = await fetchAllPages<StorageNodeBalance>((page, perPage) =>
    nodes.getList(page, perPage, `node_id = "${nodeId}"`)
  );
  return balances.reduce((sum, b) => sum + (Number(b.claimed_gb) || 0), 0);
}

/** One (user, node) pair's effective claim. 0 when there is no row. */
export async function getUserNodeClaimedGb(
  pb: TypedPocketBase,
  userId: string,
  nodeId: string
): Promise<number> {
  const nodes = new StorageNodeBalanceMutator(pb);
  const balance = await nodes.findByUserAndNode(userId, nodeId);
  return Number(balance?.claimed_gb) || 0;
}

export interface AllBalances {
  nodeBalancesByUser: Map<string, StorageNodeBalance[]>;
  userBalances: Map<string, StorageUserBalance>;
}

/** Every balance row, bucketed by user — backs the admin list view. */
export async function getAllBalances(
  pb: TypedPocketBase
): Promise<AllBalances> {
  const nodes = new StorageNodeBalanceMutator(pb);
  const users = new StorageUserBalanceMutator(pb);

  const [allNodes, allUsers] = await Promise.all([
    fetchAllPages<StorageNodeBalance>((page, perPage) =>
      nodes.getList(page, perPage)
    ),
    fetchAllPages<StorageUserBalance>((page, perPage) =>
      users.getList(page, perPage)
    ),
  ]);

  const nodeBalancesByUser = new Map<string, StorageNodeBalance[]>();
  for (const balance of allNodes) {
    const existing = nodeBalancesByUser.get(balance.user);
    if (existing) existing.push(balance);
    else nodeBalancesByUser.set(balance.user, [balance]);
  }

  const userBalances = new Map<string, StorageUserBalance>();
  for (const balance of allUsers) userBalances.set(balance.user, balance);

  return { nodeBalancesByUser, userBalances };
}
