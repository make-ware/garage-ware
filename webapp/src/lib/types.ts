// Local TypeScript types for webapp
// These types use the webapp's PocketBase version to avoid type mismatches

import PocketBase from 'pocketbase';
import type { RecordService } from 'pocketbase';
import type {
  User,
  Admin,
  AccessKey,
  Bucket,
  StorageClaim,
  StorageClaimAudit,
  StorageNodeBalance,
  StorageUserBalance,
  StorageTransfer,
  StorageInvite,
  NodeMetric,
  GarageClusterCache,
  ClusterEvent,
  NodeOwner,
  ClusterEventKind,
  ClusterEventSeverity,
  ClusterEventSource,
} from '@garage-ware/shared';
import type { NodeClaimPosition } from '@/lib/storage/ledger-math';
import type { NodeKey } from '@/lib/node-label';

export interface TypedPocketBase extends PocketBase {
  collection(idOrName: 'Users' | 'users'): RecordService<User>;
  collection(idOrName: 'Admins'): RecordService<Admin>;
  collection(idOrName: 'AccessKeys'): RecordService<AccessKey>;
  collection(idOrName: 'Buckets'): RecordService<Bucket>;
  collection(idOrName: 'StorageClaims'): RecordService<StorageClaim>;
  collection(idOrName: 'StorageClaimAudit'): RecordService<StorageClaimAudit>;
  collection(
    idOrName: 'StorageNodeBalances'
  ): RecordService<StorageNodeBalance>;
  collection(
    idOrName: 'StorageUserBalances'
  ): RecordService<StorageUserBalance>;
  collection(idOrName: 'StorageTransfers'): RecordService<StorageTransfer>;
  collection(idOrName: 'StorageInvites'): RecordService<StorageInvite>;
  collection(idOrName: 'NodeMetrics'): RecordService<NodeMetric>;
  collection(idOrName: 'GarageClusterCache'): RecordService<GarageClusterCache>;
  collection(idOrName: 'ClusterEvents'): RecordService<ClusterEvent>;
  collection(idOrName: 'NodeOwners'): RecordService<NodeOwner>;
}

/**
 * A transfer row carrying the counterparty's email rather than only their id.
 *
 * `StorageTransfers` stores relations, and a user cannot resolve another
 * user's record (the Users listRule is self-or-admin) — so the address is
 * attached server-side by `GET /next-api/garage/transfers`. It stays optional:
 * a counterparty whose account has since been deleted has no address to show.
 */
export type LabelledTransfer = StorageTransfer & {
  from_email?: string;
  to_email?: string;
};

export type BucketWithUsage = Bucket & {
  bytes?: number;
  objects?: number;
  maxObjects?: number | null;
};

/**
 * A user's complete storage position, computed in one place by the
 * `getUserStorageSummary` service and served from `/next-api/garage/storage-summary`.
 * This is the single shared shape both the dashboard and bucket-detail pages
 * consume so the claims − transfers − allocated math never diverges.
 *
 * `nodeClaims` is the per-node breakdown rather than the raw ledger entries:
 * the position is read from the materialized balances now, which store the
 * roll-up, and every consumer only ever wanted the roll-up anyway.
 */
export interface StorageSummary {
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

/**
 * One node's identity as `GET /next-api/garage/node-metrics` reports it.
 *
 * `node_id` is a node key, like every other node id on the wire. There is no
 * `node_hostname`: a node is identified by its name or its key, the column has
 * never been either, and this payload goes to any signed-in user.
 */
export interface MetricNode {
  node_id: NodeKey;
  node_zone: string;
}

/**
 * One (node, time-bucket) aggregate from the metrics history. `null` means
 * "no valid reading in this bucket" — a chart gap, never a zero (see the
 * NodeMetrics schema notes in shared/src/schema/node-metric.ts).
 *
 * The stored rows' `layout_ok` / `node_stats_ok` gates do not survive to here:
 * bucketHistory has already turned a failed reading into a `null`. So
 * `stored_partitions` is null when *no* sample in the bucket carried a layout
 * reading — and **0 when the node held no role at all** (a gateway, or one
 * draining out of an older layout). Distinguishing those two is the whole
 * reason `layout_ok` exists on the row. It can also come out fractional, when
 * a layout change landed mid-bucket.
 */
export interface MetricPoint {
  t: number;
  node_id: NodeKey;
  samples: number;
  uptime_pct: number;
  resync_queue_length: number | null;
  resync_errored_blocks: number | null;
  /** Blocks the node's metadata holds a refcount for. */
  rc_entries: number | null;
  /** Partitions the layout assigns this node; 0 means "no role". */
  stored_partitions: number | null;
  /** Cluster-wide bytes per partition at sample time. */
  partition_size_bytes: number | null;
  data_total_bytes: number | null;
  data_available_bytes: number | null;
  meta_total_bytes: number | null;
  meta_available_bytes: number | null;
}

/** `GET /next-api/garage/node-metrics` — bucketed per-node history. */
export interface NodeMetricsHistory {
  range: string;
  bucketSeconds: number;
  nodes: MetricNode[];
  points: MetricPoint[];
}

/**
 * One layout node as `GET /next-api/garage/cluster/nodes` reports it: the
 * layout role joined with the node's live status. Status fields are `null`
 * when the node is in the layout but absent from `GetClusterStatus` — an
 * unknown, distinct from down. The payload deliberately carries no `addr`;
 * node network addresses never reach the browser (the same reason
 * `GarageClusterCache` is superuser-only).
 *
 * It also carries no `hostname`: a node is identified by its name (from a
 * `name:` tag, see lib/node-label.ts) or by its key, never by an OS-reported
 * hostname. The field is left off so the compiler keeps it that way.
 *
 * `id` is a **node key**, not a full node id. The full id is the credential the
 * node-claim route accepts and never leaves the server; see lib/node-label.ts.
 */
export interface ClusterNodeItem {
  id: NodeKey;
  zone: string;
  tags: string[];
  capacity: number | null;
  isUp: boolean | null;
  draining: boolean | null;
  garageVersion: string | null;
  lastSeenSecsAgo: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  metaFreeBytes: number | null;
  metaTotalBytes: number | null;
}

/**
 * `GET /next-api/garage/buckets/claimable` — one bucket the caller's own access
 * key holds Garage `owner` permission on, and which has no PocketBase row yet.
 *
 * Nothing here is privileged: the caller could read the same list from Garage
 * with their own credentials.
 */
export interface ClaimableBucket {
  id: string;
  /** Global alias, or the raw id when a bucket has none. */
  name: string;
  bytes: number | null;
  objects: number | null;
  /** Garage's `maxSize`, so the UI can say what claiming would reserve. */
  maxSize: number | null;
  /** The caller's key that proves ownership. */
  viaKeyId: string;
}

/** `GET /next-api/garage/cluster/nodes` — any signed-in user. */
export interface ClusterNodesResponse {
  items: ClusterNodeItem[];
  replicationFactor: number;
  layoutVersion: number;
}

/** `GET /next-api/garage/events` — the cluster timeline, admin-only. */
export interface ClusterEventsResponse {
  items: ClusterEvent[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
}

/**
 * One row of the user-facing timeline: a deliberate projection of
 * `ClusterEvent`, not the record.
 *
 * `ClusterEvents` stays admin-only in PocketBase — this shape is what
 * `/next-api/garage/cluster/events` hands any signed-in user, and the
 * *omissions* are the privacy boundary. `actor_id`, `actor_email` and
 * `annotated_by` identify the admin who wrote a note and never leave the
 * server; `detail`, `previous_value`, `new_value` and `annotation` are dropped
 * because the dashboard timeline does not render them, and shipping a field
 * nobody displays is how it ends up displayed later by accident.
 *
 * `category` **is** carried: it is a closed enum, identifies nobody, and is
 * the badge — a manual row's kind is always `note`, so the category is the
 * only word on it worth reading.
 *
 * `node_hostname` / `node_zone` are dropped for a different reason: per
 * `lib/node-label.ts` the hostname is the detector's stored fallback and
 * explicitly *not* how a node is labelled, so the client resolves names from
 * the live layout it already holds.
 */
export interface ClusterTimelineEvent {
  id: string;
  kind: ClusterEventKind;
  source: ClusterEventSource;
  severity: ClusterEventSeverity;
  /** '' for a cluster-wide event — a layout bump, or a note about no node. */
  node_id: NodeKey;
  /** Manual rows only; '' on a detector row, which never guesses a cause. */
  category: string;
  title: string;
  occurred_at: string;
  /** '' means still open. Only meaningful on a manual row. */
  ended_at: string;
}

/** `GET /next-api/garage/cluster/events` — any signed-in user. */
export interface ClusterTimelineResponse {
  items: ClusterTimelineEvent[];
  /**
   * Every open manual note, **unwindowed** — an open row pinned to a node is
   * what puts it "under repair", and a repair open longer than the window is
   * the one most worth showing. Overlaps `items` for recent ones; they serve
   * different questions ("what changed" vs "what is still wrong").
   */
  openEvents: ClusterTimelineEvent[];
  /**
   * How many rows fall in the window, which may exceed `items.length`. The
   * card says so when it does — a truncated list that looks complete is the
   * "no silent caps" failure.
   */
  totalItems: number;
  windowStart: string;
  windowEnd: string;
  days: number;
}
