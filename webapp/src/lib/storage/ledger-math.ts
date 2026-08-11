/**
 * Pure storage-accounting arithmetic, shared by the server-only services under
 * `lib/storage/` and by client components.
 *
 * Everything else in this directory is `import 'server-only'`, which is why
 * this module exists separately: the admin console and the user dashboard both
 * need to roll up claim ledgers and value node capacity, and they were each
 * doing it by hand. Two hand-rolled copies of an accounting formula is two
 * chances to disagree — and they did, over whether a claim on a node missing
 * from the layout counts. It does not.
 *
 * No I/O here. Callers fetch the rows; these functions turn them into numbers.
 */
import type { StorageClaim, StorageTransfer } from '@garage-ware/shared';
import { sumEntries } from '@garage-ware/shared/mutators';
import type { ClusterLayout } from '@/lib/garage';
import { bytesToGib } from '@/lib/storage/units';

export { sumEntries };

/** Sum a set of transfer rows, tolerating null/undefined amounts. */
export function sumTransfers(transfers: readonly StorageTransfer[]): number {
  return transfers.reduce((sum, t) => sum + (Number(t.quota_gb) || 0), 0);
}

/** Ids of the nodes currently carrying a role in the layout. */
export function presentNodeIdSet(layout: ClusterLayout): Set<string> {
  return new Set(layout.roles.map((r) => r.id));
}

/**
 * Drop claims pointing at nodes that have left the layout.
 *
 * Decommissioned hardware must not back a bucket, so its claims are valued at
 * zero everywhere the accounting is conservative. Passing no layout means "do
 * not filter" — the raw ledger view.
 */
export function filterPresentClaims(
  claims: readonly StorageClaim[],
  layout?: ClusterLayout
): StorageClaim[] {
  if (!layout) return [...claims];
  const present = presentNodeIdSet(layout);
  return claims.filter((c) => present.has(c.node_id));
}

/**
 * Logical GB a node can back: raw capacity divided by the replication factor.
 * Returns null when the node is absent from the layout or declares no capacity
 * — the caller decides what that means (usually "can only be wound down").
 */
export function nodeUsableGbFrom(
  capacityBytes: number | null | undefined,
  replicationFactor: number
): number | null {
  if (!capacityBytes || capacityBytes <= 0) return null;
  return bytesToGib(capacityBytes) / Math.max(replicationFactor, 1);
}

/** Look a node's usable GB up directly from a layout. */
export function nodeUsableGbInLayout(
  layout: ClusterLayout | null | undefined,
  nodeId: string,
  replicationFactor: number
): number | null {
  const role = layout?.roles.find((r) => r.id === nodeId);
  return nodeUsableGbFrom(role?.capacity, replicationFactor);
}

/**
 * One node's position for a single user.
 *
 * The same shape whether it was rolled up from raw ledger entries or read from
 * the materialized StorageNodeBalances cache — that equivalence is what lets
 * the read path switch to the cache without every consumer noticing.
 */
export interface NodeClaimPosition {
  nodeId: string;
  /**
   * Deliberately no `nodeHostname`. The ledger snapshots one at write time and
   * never refreshes it, so projecting it here is what let a renamed node keep
   * showing its old label. Views resolve a node's name from the live layout by
   * `nodeId` instead — see lib/node-label.ts.
   */
  nodeZone?: string;
  /** Sum of the ledger entries for this node. */
  claimedGb: number;
  /** False when the node has left the layout, i.e. this claim counts for nothing. */
  presentInLayout: boolean;
  /** How many ledger entries back the sum. */
  entryCount: number;
}

/** A {@link NodeClaimPosition} that also carries the entries it was built from. */
export interface NodeClaimRollup extends NodeClaimPosition {
  /** Newest first. */
  entries: StorageClaim[];
}

/** One (user, node) pair, rolled up from its ledger entries. */
export interface UserNodeClaimRollup extends NodeClaimRollup {
  /** `${userId}::${nodeId}` — stable React key and map key. */
  key: string;
  userId: string;
}

/** `${userId}::${nodeId}`, the key both roll-ups and the admin UI agree on. */
export function userNodeKey(userId: string, nodeId: string): string {
  return `${userId}::${nodeId}`;
}

function newestFirst(a: StorageClaim, b: StorageClaim): number {
  return a.created < b.created ? 1 : -1;
}

/**
 * Roll a claim ledger up per (user, node).
 *
 * Entries are signed adjustments, so several rows can describe one node; the
 * UI wants the effective claim, not the grant history, and gets the history
 * alongside it for the expandable views.
 */
export function rollUpClaimsByUserNode(
  claims: readonly StorageClaim[],
  layout?: ClusterLayout
): UserNodeClaimRollup[] {
  const present = layout ? presentNodeIdSet(layout) : null;
  const map = new Map<string, UserNodeClaimRollup>();

  for (const claim of claims) {
    const key = userNodeKey(claim.user, claim.node_id);
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        userId: claim.user,
        nodeId: claim.node_id,
        nodeZone: claim.node_zone,
        claimedGb: 0,
        presentInLayout: present ? present.has(claim.node_id) : true,
        entryCount: 0,
        entries: [],
      };
      map.set(key, group);
    }
    group.claimedGb += Number(claim.quota_gb) || 0;
    group.entryCount += 1;
    group.entries.push(claim);
    // The newest entry carries the freshest node metadata.
    group.nodeZone ??= claim.node_zone;
  }

  const groups = [...map.values()];
  for (const group of groups) group.entries.sort(newestFirst);
  return groups;
}

/**
 * Roll a single user's claim ledger up per node.
 *
 * `includeZero: false` (the default) drops nodes whose entries net to zero —
 * a claim that has been fully wound down is not worth listing.
 */
export function rollUpClaimsByNode(
  claims: readonly StorageClaim[],
  layout?: ClusterLayout,
  options: { includeZero?: boolean } = {}
): NodeClaimRollup[] {
  const present = layout ? presentNodeIdSet(layout) : null;
  const map = new Map<string, NodeClaimRollup>();

  for (const claim of claims) {
    let group = map.get(claim.node_id);
    if (!group) {
      group = {
        nodeId: claim.node_id,
        nodeZone: claim.node_zone,
        claimedGb: 0,
        presentInLayout: present ? present.has(claim.node_id) : true,
        entryCount: 0,
        entries: [],
      };
      map.set(claim.node_id, group);
    }
    group.claimedGb += Number(claim.quota_gb) || 0;
    group.entryCount += 1;
    group.entries.push(claim);
    group.nodeZone ??= claim.node_zone;
  }

  const groups = [...map.values()];
  for (const group of groups) group.entries.sort(newestFirst);
  return options.includeZero ? groups : groups.filter((g) => g.claimedGb !== 0);
}

/** Total claimed on each node across all users — what the node has promised. */
export function sumClaimsByNode(
  claims: readonly StorageClaim[]
): Map<string, number> {
  const map = new Map<string, number>();
  for (const claim of claims) {
    map.set(
      claim.node_id,
      (map.get(claim.node_id) ?? 0) + (Number(claim.quota_gb) || 0)
    );
  }
  return map;
}

/** Effective claim per (user, node) pair, keyed by {@link userNodeKey}. */
export function sumClaimsByUserNode(
  claims: readonly StorageClaim[]
): Map<string, number> {
  const map = new Map<string, number>();
  for (const claim of claims) {
    const key = userNodeKey(claim.user, claim.node_id);
    map.set(key, (map.get(key) ?? 0) + (Number(claim.quota_gb) || 0));
  }
  return map;
}

/** A user's complete storage position. Mirrors the `StorageSummary` shape. */
export interface ComputedStorageSummary {
  /** Per-node breakdown, whether derived from entries or from the balance cache. */
  nodeClaims: NodeClaimPosition[];
  sentTransfers: StorageTransfer[];
  receivedTransfers: StorageTransfer[];
  claimsGb: number;
  sentGb: number;
  receivedGb: number;
  netGrantedGb: number;
  allocatedGb: number;
  availableGb: number;
}

/** The subset of a StorageNodeBalances row the arithmetic needs. */
export interface NodeBalanceLike {
  node_id: string;
  claimed_gb: number;
  entry_count?: number;
  node_hostname?: string;
  node_zone?: string;
}

/** The subset of a StorageUserBalances row the arithmetic needs. */
export interface UserBalanceLike {
  sent_gb: number;
  received_gb: number;
  allocated_gb: number;
}

/** Turn materialized per-node rows into the shared display/position shape. */
export function nodePositionsFromBalances(
  balances: readonly NodeBalanceLike[],
  layout?: ClusterLayout
): NodeClaimPosition[] {
  const present = layout ? presentNodeIdSet(layout) : null;
  return balances.map((b) => ({
    nodeId: b.node_id,
    // `node_hostname` is accepted on the input row (it mirrors the DB column)
    // but deliberately not projected — see NodeClaimPosition.
    nodeZone: b.node_zone || undefined,
    claimedGb: Number(b.claimed_gb) || 0,
    presentInLayout: present ? present.has(b.node_id) : true,
    entryCount: Number(b.entry_count) || 0,
  }));
}

/**
 * The same position as {@link computeStorageSummary}, from the materialized
 * balances instead of the raw ledger.
 *
 * This is the whole reason the cache is stored per (user, node) rather than as
 * one net figure: the layout filter is applied *here*, at read time, where the
 * live layout is actually available. A PocketBase hook cannot reach Garage, so
 * a pre-filtered number written by a hook would silently keep counting
 * decommissioned nodes.
 *
 * `userBalance` may be null — a user who has never been party to a transfer or
 * owned a bucket simply has no row, which is a zeroed position, not an error.
 */
export function computeSummaryFromBalances(
  nodeBalances: readonly NodeBalanceLike[],
  userBalance: UserBalanceLike | null | undefined,
  layout?: ClusterLayout
): ComputedStorageSummary {
  const nodeClaims = nodePositionsFromBalances(nodeBalances, layout);
  const claimsGb = nodeClaims
    .filter((n) => n.presentInLayout)
    .reduce((sum, n) => sum + n.claimedGb, 0);
  const sentGb = Number(userBalance?.sent_gb) || 0;
  const receivedGb = Number(userBalance?.received_gb) || 0;
  const allocatedGb = Number(userBalance?.allocated_gb) || 0;
  const netGrantedGb = claimsGb + receivedGb - sentGb;

  return {
    nodeClaims,
    // Balances hold sums, not rows. Callers that need the individual transfers
    // for display fetch them separately; the numbers here do not depend on it.
    sentTransfers: [],
    receivedTransfers: [],
    claimsGb,
    sentGb,
    receivedGb,
    netGrantedGb,
    allocatedGb,
    availableGb: Math.max(netGrantedGb - allocatedGb, 0),
  };
}

/**
 * THE storage formula. Everything that needs a user's position calls this.
 *
 *   netGranted = claims(on nodes still in the layout) + received − sent
 *   available  = netGranted − allocated
 *
 * The layout filter applies to claims only: transfers are node-agnostic, so
 * decommissioning a node cannot retroactively unwind a handoff.
 */
export function computeStorageSummary(
  claims: readonly StorageClaim[],
  sentTransfers: readonly StorageTransfer[],
  receivedTransfers: readonly StorageTransfer[],
  allocatedGb: number,
  layout?: ClusterLayout
): ComputedStorageSummary {
  const claimsGb = sumEntries(filterPresentClaims(claims, layout));
  const sentGb = sumTransfers(sentTransfers);
  const receivedGb = sumTransfers(receivedTransfers);
  const netGrantedGb = claimsGb + receivedGb - sentGb;

  return {
    // includeZero so a fully wound-down node still appears, matching what the
    // balance-backed path returns (it keeps the row until the ledger is empty).
    nodeClaims: rollUpClaimsByNode(claims, layout, { includeZero: true }),
    sentTransfers: [...sentTransfers],
    receivedTransfers: [...receivedTransfers],
    claimsGb,
    sentGb,
    receivedGb,
    netGrantedGb,
    allocatedGb,
    availableGb: Math.max(netGrantedGb - allocatedGb, 0),
  };
}
