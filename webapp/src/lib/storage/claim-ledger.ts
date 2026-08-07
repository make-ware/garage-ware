import 'server-only';
import { HttpError } from '@/lib/auth/server';
import { formatStorage } from '@/lib/format';
import {
  getNodeClaimedGb,
  getUserBalances,
  getUserNodeClaimedGb,
} from '@/lib/storage/balances';
import {
  computeSummaryFromBalances,
  nodeUsableGbInLayout,
} from '@/lib/storage/ledger-math';
import { cluster, type GarageClient, type ClusterLayout } from '@/lib/garage';
import type { TypedPocketBase } from '@/lib/types';

export interface ClaimDelta {
  userId: string;
  nodeId: string;
  /**
   * Signed change to the user's effective claim on this node, in logical
   * (post-replication) GB. Appending an entry of X is `+X`; deleting an entry
   * of X is `-X`; editing an entry from X to Y is `Y - X`.
   */
  deltaGb: number;
}

export interface ClaimContext {
  layout: ClusterLayout;
  replicationFactor: number;
}

/** Fetch the live layout + replication factor once per request. */
export async function loadClaimContext(
  garage: GarageClient
): Promise<ClaimContext> {
  const [layout, replicationFactor] = await Promise.all([
    cluster.getLayout(garage),
    cluster.getReplicationFactor(garage),
  ]);
  return { layout, replicationFactor };
}

/**
 * Logical GB a node can back, i.e. raw capacity divided by replication.
 * The admin console needs the same number client-side, so the arithmetic lives
 * in `ledger-math` and this is the server-side convenience wrapper.
 */
export function nodeUsableGb(ctx: ClaimContext, nodeId: string): number | null {
  return nodeUsableGbInLayout(ctx.layout, nodeId, ctx.replicationFactor);
}

/**
 * Guard every mutation of the claim ledger against the three storage invariants.
 * Because entries are signed, each check is expressed against the *effective
 * sum after applying `delta`* — so append, edit, and delete all reduce to the
 * same three questions, and no entry needs to be excluded from the sums.
 *
 * 1. Node capacity:   sum(entries on node) ≤ node.capacity / replicationFactor
 * 2. Per-user-node:   sum(user's entries on node) ≥ 0. Without this a user
 *    could hold −5 TB on one node and +5 TB on another and net out fine, while
 *    the negative row silently freed capacity on the first node for others to
 *    over-claim.
 * 3. Already-allocated: the user's net granted total (claims ± transfers) must
 *    still cover the buckets they have already sized.
 */
export async function assertClaimDeltaAllowed(
  pb: TypedPocketBase,
  ctx: ClaimContext,
  delta: ClaimDelta
): Promise<void> {
  const usableGb = nodeUsableGb(ctx, delta.nodeId);

  // A decommissioned node can only ever be wound down, never grown.
  if (usableGb === null) {
    if (delta.deltaGb > 0) {
      throw new HttpError(
        400,
        `Node ${delta.nodeId} is not present in the cluster layout or has no declared capacity — you can only reduce or remove claims on it`
      );
    }
  }

  // All four figures come from the materialized balances. They used to be four
  // ledger scans capped at one page each, which meant this guard — the one
  // thing standing between the cluster and an over-allocated node — quietly
  // stopped being correct once a ledger outgrew 1000 rows.
  const [nodeSumGb, userNodeSumGb, balances] = await Promise.all([
    getNodeClaimedGb(pb, delta.nodeId),
    getUserNodeClaimedGb(pb, delta.userId, delta.nodeId),
    getUserBalances(pb, delta.userId),
  ]);
  const position = computeSummaryFromBalances(
    balances.nodeBalances,
    balances.userBalance,
    ctx.layout
  );
  const grantedGb = position.netGrantedGb;
  const allocatedGb = position.allocatedGb;

  if (usableGb !== null && nodeSumGb + delta.deltaGb > usableGb) {
    throw new HttpError(
      400,
      `Adjustment exceeds node usable capacity (claimed ${formatStorage(nodeSumGb)} + ${formatStorage(delta.deltaGb)} > usable ${formatStorage(usableGb)})`
    );
  }

  if (userNodeSumGb + delta.deltaGb < 0) {
    throw new HttpError(
      400,
      `Adjustment would drive this user's claim on the node negative (currently ${formatStorage(userNodeSumGb)}, adjusting by ${formatStorage(delta.deltaGb)})`
    );
  }

  // `grantedGb` already excludes claims on absent nodes, so a delta against a
  // decommissioned node does not move it — the check is a no-op there, which
  // is what we want: winding such a claim down never strands a bucket.
  const grantedAfterGb =
    usableGb === null ? grantedGb : grantedGb + delta.deltaGb;
  if (grantedAfterGb < allocatedGb) {
    throw new HttpError(
      400,
      `Adjustment would drop the user below their already-allocated buckets (allocated ${formatStorage(allocatedGb)} > remaining claim ${formatStorage(grantedAfterGb)}). Reduce or remove the user's buckets first.`
    );
  }
}
