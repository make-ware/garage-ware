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

/**
 * How close to zero counts as zero, relative to the magnitudes subtracted to
 * get there. Float error grows with those magnitudes, so a fixed absolute
 * threshold is either too tight on a large cluster or too loose on a small one.
 */
const ZERO_EPSILON_RATIO = 1e-11;

/**
 * Fold float noise at zero, rounding nothing else.
 *
 * An earlier cut rounded every intermediate to six decimals, which at ledger
 * magnitudes is itself the bug: claims are stored in GiB, so a 36 TB grant is
 * 33527.61268615723 — six decimals is a *relative* precision of 3e-11, and the
 * up-to-5e-7 error each rounding introduces is carried into the next
 * subtraction, where it can no longer cancel. A pair that began from nothing
 * came out at exactly 1e-6 GiB and rendered as "1.07 KB → 36 TB".
 *
 * Only zero needs defending. Display rounding hides a residue on a large
 * figure, but beside zero the smallest unit the formatter reaches for is bytes,
 * so noise there is the one place it becomes a visible claim about the past.
 * The subtraction therefore stays exact, and a result within float noise of
 * zero — scaled to the operands the error came from — is reported as the zero
 * it is. `scale` of 0 still snaps, which is the right answer for 0 − 0.
 */
function snapZeroGb(value: number, scale: number): number {
  return Math.abs(value) <= Math.abs(scale) * ZERO_EPSILON_RATIO ? 0 : value;
}

/** A (user, node) pair's effective claim either side of one audit row. */
export interface AuditPosition {
  /** The pair's effective claim immediately before the change. */
  beforeGb: number;
  /** ...and immediately after it. */
  afterGb: number;
}

/** The subset of a StorageClaimAudit row this arithmetic needs. */
export interface AuditDeltaLike {
  id: string;
  delta_gb?: number;
}

/**
 * Reconstruct the (user, node) claimed position either side of every audit row.
 *
 * `StorageClaimAudit.previous_gb` / `new_gb` describe the *entry* that moved,
 * not the position it moved. For a create that is always `0 -> amount`, which
 * rendered beside a 36 TB claim reads "0 B -> 4 TB" — as though the grant had
 * been wiped and re-issued. The position is not on the row and should not be:
 * a hook writing one would be trusting its own history, and rewriting the
 * column now would restate rows in a collection whose whole point is that it
 * is never restated. It is recoverable here, because the deltas are signed and
 * the trail is complete.
 *
 * Anchored on the **present**, not on the beginning: `currentClaimedGb` is the
 * pair's live ledger sum and therefore the newest row's `afterGb`, and each
 * older row's `afterGb` is the next one's `beforeGb`. Anchoring the other way
 * would assume the trail reaches back to the pair's first entry, which it need
 * not — the collection postdates some claims, and callers read one page of it.
 * Walking backwards makes an incomplete tail lose precision at the far end
 * only, where it is honest, rather than skewing every row.
 *
 * `entriesNewestFirst` must arrive in the order StorageClaimAuditMutator sorts
 * (`-created`): the walk is a running subtraction, so the order *is* the
 * arithmetic. Nothing is rounded along the way — see {@link snapZeroGb} for
 * why rounding intermediates is what makes a position wrong rather than tidy.
 */
export function positionsForAuditTrail(
  entriesNewestFirst: readonly AuditDeltaLike[],
  currentClaimedGb: number
): Map<string, AuditPosition> {
  const positions = new Map<string, AuditPosition>();
  let afterGb = Number(currentClaimedGb) || 0;
  for (const entry of entriesNewestFirst) {
    const deltaGb = Number(entry.delta_gb) || 0;
    const beforeGb = snapZeroGb(
      afterGb - deltaGb,
      Math.max(Math.abs(afterGb), Math.abs(deltaGb))
    );
    positions.set(entry.id, { beforeGb, afterGb });
    afterGb = beforeGb;
  }
  return positions;
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
