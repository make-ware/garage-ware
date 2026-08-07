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

/** One node's position for a single user, rolled up from its ledger entries. */
export interface NodeClaimRollup {
  nodeId: string;
  nodeHostname?: string;
  nodeZone?: string;
  /** Sum of the ledger entries for this node. */
  claimedGb: number;
  /** False when the node has left the layout, i.e. this claim counts for nothing. */
  presentInLayout: boolean;
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
        nodeHostname: claim.node_hostname,
        nodeZone: claim.node_zone,
        claimedGb: 0,
        presentInLayout: present ? present.has(claim.node_id) : true,
        entries: [],
      };
      map.set(key, group);
    }
    group.claimedGb += Number(claim.quota_gb) || 0;
    group.entries.push(claim);
    // The newest entry carries the freshest node metadata.
    group.nodeHostname ??= claim.node_hostname;
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
        nodeHostname: claim.node_hostname,
        nodeZone: claim.node_zone,
        claimedGb: 0,
        presentInLayout: present ? present.has(claim.node_id) : true,
        entries: [],
      };
      map.set(claim.node_id, group);
    }
    group.claimedGb += Number(claim.quota_gb) || 0;
    group.entries.push(claim);
    group.nodeHostname ??= claim.node_hostname;
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
  claims: StorageClaim[];
  sentTransfers: StorageTransfer[];
  receivedTransfers: StorageTransfer[];
  claimsGb: number;
  sentGb: number;
  receivedGb: number;
  netGrantedGb: number;
  allocatedGb: number;
  availableGb: number;
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
    claims: [...claims],
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
