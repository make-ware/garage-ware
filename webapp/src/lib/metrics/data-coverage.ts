import type { MetricPoint } from '@/lib/types';

/**
 * Detect nodes that are holding less data than the share of the ring they were
 * assigned — the case a replaced drive produces and nothing else notices.
 *
 * A node that rejoins after its data drive is wiped reports **healthy**:
 * `isUp` is true, it is connected, and GetClusterHealth's `partitionsAllOk`
 * stays at 256/256, because that number is derived from connectivity, not from
 * stored bytes. Nothing sees the hole until `garage repair blocks` has refilled
 * it.
 *
 * The fact that makes a measurement possible: **a stored partition holds one
 * full replica of that partition's data, whatever the reason it was assigned.**
 * Heterogeneous drive sizes and zone-redundancy constraints change *how many*
 * partitions a node gets, never *how much data one partition holds*. So
 * `usedBytes / storedPartitions` is near-uniform across healthy storage nodes,
 * and a node well below the pack is a node missing data. Garage exposes no
 * per-node "bytes I own" or "partitions I actually hold data for", so this is
 * inherently comparative.
 *
 * Three ratios per node, and they are algebraically linked —
 * `bytesPerPartition = entriesPerPartition × bytesPerEntry`:
 *   - **bytes per partition** — what the node has on disk per unit of ring.
 *   - **rc entries per partition** — how many blocks the node's *metadata*
 *     claims per unit of ring. Metadata converges on the fast table-sync path;
 *     block data moves on the slow resync path, so "rc normal, bytes low" is
 *     the fingerprint of a wiped data drive with intact metadata — this is
 *     what separates *missing data* from *still rebuilding*.
 *   - **bytes per claimed block** — for each block the node says it owns, how
 *     many bytes it actually has. This is the sharpest answer to "is the
 *     stored data short", because it is immune to partition-assignment skew:
 *     blocks are content-addressed and hash-distributed, so their average size
 *     is identical across nodes in expectation, and at millions of blocks per
 *     node the law of large numbers makes that tight in practice.
 *
 * **Both byte axes gate**, and `dataShortfallPct` is the larger of the two.
 * Measured on a live 7-node cluster, a node whose metadata claimed 5% *more*
 * blocks per partition than its peers while holding 25% fewer bytes per block
 * read only 21% short on bytes-per-partition — its inflated block count was
 * masking the byte shortfall. Gating on bytes-per-partition alone would have
 * missed exactly the failure this module exists to catch.
 *
 * The cluster expectation is the **median**, never the mean: the estimator has
 * to survive the outlier it is looking for. With 3 nodes and one wiped, the
 * mean falls to ⅔ of normal, so the broken node reads a 33% shortfall instead
 * of ~100% — it masks itself and drags its healthy peers toward the alarm bar.
 *
 * `shortfallPct` clamps at 0 below, so the measure is **one-sided**: an
 * over-full node never alarms. That is what makes draining nodes, capacity
 * reductions, and stray non-Garage files on the data filesystem safe — all
 * push bytes-per-partition *up*.
 *
 * Not `server-only`, like `ledger-math.ts` / `object-cap.ts` / `node-label.ts`
 * / `units.ts`: the metrics page judges client-side, and a second hand-rolled
 * copy in a component is how the two would come to disagree.
 *
 * ---
 *
 * **Hazard.** `storedPartitions × partitionSize` (Garage's own
 * `usableCapacity`) is a strictly more accurate answer to "how much of this
 * node is usable" than `nodeUsableGbFrom(capacity, rf)` — it accounts for the
 * zone-redundancy constraints that `capacity / replicationFactor` ignores, and
 * will routinely be *lower*. That is exactly why it is dangerous here. The
 * per-node claim invariant is defined as
 * `sum(claim.quota_gb on node) ≤ node.capacity / replicationFactor` and is
 * enforced by `assertClaimDeltaAllowed`; substituting the better number would
 * silently revalue every node's ceiling downward and could retroactively
 * invalidate existing claims. So: this module stays in **bytes**, never GB, so
 * it cannot typecheck into a ledger call site; it lives in `lib/metrics/`,
 * which nothing in the accounting path imports, never `lib/storage/`; and
 * nothing it produces is rendered under a "Capacity" heading. **Display only
 * — changing the claim invariant's denominator is a storage-accounting
 * change, not a metrics change.**
 */

/**
 * Shortfall from the cluster median at which a node is flagged.
 *
 * Calibrated against a live 7-node cluster of wildly heterogeneous hardware
 * (24 TB to 120 TB, 42 to 214 partitions): the six healthy nodes sat within
 * −1.1%/+1.9% of the median on bytes-per-partition and −2.2%/+1.9% on
 * bytes-per-block. 10% is roughly 5× that observed spread — loose enough to
 * absorb hash imbalance, block-GC timing and filesystem reserved blocks, tight
 * enough to catch a real hole. The earlier 0.25 was ~11× the healthy spread
 * and let a node missing ~17 TB read as fine.
 *
 * The one benign cause of a genuinely *low* reading is a node compressing or
 * deduplicating differently from its peers (e.g. one ZFS node in an ext4
 * cluster). That is an operator inconsistency worth surfacing anyway.
 */
export const SHORTFALL_WARN = 0.1;

/** Shortfall at which the UI leans on the wording. Copy only, never gating. */
export const SHORTFALL_SEVERE = 0.25;

/** Contributing nodes needed before the median means anything. */
export const MIN_PEER_READINGS = 3;

/** Below this median, ratios are noise rather than measurement. */
export const MIN_MEDIAN_BYTES_PER_PARTITION = 64 * 1024 * 1024;

/** rc-entry shortfall at which a node counts as "still learning its blocks". */
export const RC_COVERAGE_BEHIND = 0.15;

export interface CoverageInput {
  nodeId: string;
  /** Down nodes contribute nothing — a different alarm, which uptime owns. */
  isUp: boolean;
  usedBytes: number | null;
  /** `null` = layout unknown; `0` = holds no partitions (gateway, draining). */
  storedPartitions: number | null;
  rcEntries: number | null;
  resyncQueueLength: number | null;
}

export type CoverageStatus = 'ok' | 'rebuilding' | 'missing-data' | 'unknown';

export type CoverageReason =
  | 'node-down'
  | 'layout-unavailable'
  | 'no-role'
  | 'no-partition-reading'
  | 'too-few-peers'
  | 'cluster-too-empty';

export interface NodeCoverage {
  nodeId: string;
  status: CoverageStatus;
  /** Non-null exactly when `status === 'unknown'`. */
  reason: CoverageReason | null;
  bytesPerPartition: number | null;
  entriesPerPartition: number | null;
  /** This node's average on-disk block size. */
  bytesPerEntry: number | null;
  /** Bytes-per-partition vs median: clamp(1 − own / median, 0, 1), one-sided. */
  shortfallPct: number | null;
  /** Bytes-per-claimed-block vs median — the axis immune to assignment skew. */
  blockShortfallPct: number | null;
  /** The larger of the two byte axes. This is what gates and what sorts. */
  dataShortfallPct: number | null;
  /** Metadata coverage vs median — the *rebuilding* signal, never a gate. */
  entryShortfallPct: number | null;
  /**
   * Bytes the node is short of what its own metadata implies it holds:
   * `rcEntries × (medianBytesPerEntry − ownBytesPerEntry)`. Null when there is
   * no rc reading, or when the node is at or above the median.
   */
  missingBytes: number | null;
  severe: boolean;
}

export interface ClusterCoverage {
  medianBytesPerPartition: number | null;
  medianEntriesPerPartition: number | null;
  medianBytesPerEntry: number | null;
  contributingNodes: number;
  /**
   * The guard that suppressed every judgement, or null when the comparison
   * ran. Exposed rather than re-derived: a caller has to be able to say *why*
   * nothing is flagged, and a silent all-clear is the exact failure this
   * module exists to prevent.
   */
  guard: CoverageReason | null;
  /** Every input, in input order. */
  nodes: NodeCoverage[];
  /** `missing-data` | `rebuilding`, worst first. */
  flagged: NodeCoverage[];
}

/** Exported for tests: the middle value, or the mean of the middle two. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** clamp(1 − own / expected, 0, 1), or null when there is nothing to compare. */
function shortfallFrom(
  own: number | null,
  expected: number | null
): number | null {
  if (own === null || expected === null || expected <= 0) return null;
  return clamp01(1 - own / expected);
}

/**
 * The comparable measure for one node, or null when it cannot contribute.
 * Doubles as the metrics chart's `pick`, so the plotted series and the
 * judgement can never be computed two different ways.
 */
export function bytesPerPartition(input: CoverageInput): number | null {
  if (!input.isUp) return null;
  if (input.storedPartitions === null || input.storedPartitions <= 0)
    return null;
  if (input.usedBytes === null) return null;
  return input.usedBytes / input.storedPartitions;
}

/** Why a node cannot contribute a reading, or null when it can. */
function exclusionReason(input: CoverageInput): CoverageReason | null {
  // The ordering IS the design: each check answers a question the next one
  // would otherwise answer wrongly.
  if (!input.isUp) return 'node-down';
  if (input.storedPartitions === null) return 'layout-unavailable';
  if (input.storedPartitions <= 0) return 'no-role';
  if (input.usedBytes === null) return 'no-partition-reading';
  return null;
}

function unknown(nodeId: string, reason: CoverageReason): NodeCoverage {
  return {
    nodeId,
    status: 'unknown',
    reason,
    bytesPerPartition: null,
    entriesPerPartition: null,
    bytesPerEntry: null,
    shortfallPct: null,
    blockShortfallPct: null,
    dataShortfallPct: null,
    entryShortfallPct: null,
    missingBytes: null,
    severe: false,
  };
}

interface Contributor {
  input: CoverageInput;
  bytesPerPartition: number;
  entriesPerPartition: number | null;
  bytesPerEntry: number | null;
}

/**
 * Judge every node against the cluster median. Nodes that cannot contribute a
 * reading come back `unknown` with the reason; when a guard suppresses the
 * comparison entirely, *every* contributor comes back `unknown` too, so the
 * caller can say why rather than render a silent all-clear.
 */
export function assessCoverage(
  inputs: readonly CoverageInput[]
): ClusterCoverage {
  const excluded = new Map<string, CoverageReason>();
  const contributors: Contributor[] = [];

  for (const input of inputs) {
    const reason = exclusionReason(input);
    if (reason !== null) {
      excluded.set(input.nodeId, reason);
      continue;
    }
    // exclusionReason has already established all three are usable.
    const partitions = input.storedPartitions as number;
    const usedBytes = input.usedBytes as number;
    contributors.push({
      input,
      bytesPerPartition: usedBytes / partitions,
      entriesPerPartition:
        input.rcEntries === null ? null : input.rcEntries / partitions,
      bytesPerEntry:
        input.rcEntries === null || input.rcEntries <= 0
          ? null
          : usedBytes / input.rcEntries,
    });
  }

  const medianBytes = median(contributors.map((c) => c.bytesPerPartition));
  const medianEntries = median(
    contributors
      .map((c) => c.entriesPerPartition)
      .filter((v): v is number => v !== null)
  );
  const medianBlock = median(
    contributors
      .map((c) => c.bytesPerEntry)
      .filter((v): v is number => v !== null)
  );

  // The two guards. Both leave the medians on the result — they are honest
  // measurements — but suppress every judgement drawn from them.
  //
  // Too few peers: at n=2 the median is the mean of two, so one broken node
  // drags the expectation halfway and both nodes read ~50% short — a mutual
  // false accusation with no way to tell which is which.
  //
  // Too empty: with a near-zero median, one large object swings every ratio.
  const guard: CoverageReason | null =
    contributors.length < MIN_PEER_READINGS
      ? 'too-few-peers'
      : medianBytes === null || medianBytes < MIN_MEDIAN_BYTES_PER_PARTITION
        ? 'cluster-too-empty'
        : null;

  const byNode = new Map<string, NodeCoverage>();
  for (const c of contributors) {
    if (guard !== null) {
      byNode.set(c.input.nodeId, {
        ...unknown(c.input.nodeId, guard),
        bytesPerPartition: c.bytesPerPartition,
        entriesPerPartition: c.entriesPerPartition,
        bytesPerEntry: c.bytesPerEntry,
      });
      continue;
    }

    const shortfallPct = shortfallFrom(c.bytesPerPartition, medianBytes);
    const blockShortfallPct = shortfallFrom(c.bytesPerEntry, medianBlock);
    const entryShortfallPct = shortfallFrom(
      c.entriesPerPartition,
      medianEntries
    );
    // Both byte axes gate, and the worse one wins. An inflated metadata count
    // deflates the per-partition figure (bpp = epp × bpe), so relying on that
    // axis alone lets a node hide a byte shortfall behind extra rc entries.
    const dataShortfallPct = Math.max(
      shortfallPct ?? 0,
      blockShortfallPct ?? 0
    );
    const missingBytes =
      c.input.rcEntries !== null &&
      medianBlock !== null &&
      c.bytesPerEntry !== null &&
      c.bytesPerEntry < medianBlock
        ? c.input.rcEntries * (medianBlock - c.bytesPerEntry)
        : null;
    const queue = c.input.resyncQueueLength;

    let status: CoverageStatus;
    if (dataShortfallPct < SHORTFALL_WARN) {
      status = 'ok';
    } else if (
      entryShortfallPct !== null &&
      entryShortfallPct >= RC_COVERAGE_BEHIND
    ) {
      // Does not know about the blocks yet — metadata is still catching up.
      status = 'rebuilding';
    } else if (queue !== null && queue > 0) {
      // Knows, and is fetching.
      status = 'rebuilding';
    } else {
      // Knows, and nothing is fetching. Also the default when node stats were
      // unavailable: we cannot tell rebuilding from missing, and under-alarming
      // is the precise failure this exists to prevent. Fail loud.
      status = 'missing-data';
    }

    byNode.set(c.input.nodeId, {
      nodeId: c.input.nodeId,
      status,
      reason: null,
      bytesPerPartition: c.bytesPerPartition,
      entriesPerPartition: c.entriesPerPartition,
      bytesPerEntry: c.bytesPerEntry,
      shortfallPct,
      blockShortfallPct,
      dataShortfallPct,
      entryShortfallPct,
      missingBytes,
      severe: dataShortfallPct >= SHORTFALL_SEVERE,
    });
  }

  const nodes = inputs.map(
    (input) =>
      byNode.get(input.nodeId) ??
      unknown(
        input.nodeId,
        excluded.get(input.nodeId) ?? 'no-partition-reading'
      )
  );

  const statusRank = (s: CoverageStatus) => (s === 'missing-data' ? 0 : 1);
  const flagged = nodes
    .filter((n) => n.status === 'missing-data' || n.status === 'rebuilding')
    .sort(
      (a, b) =>
        (b.dataShortfallPct ?? 0) - (a.dataShortfallPct ?? 0) ||
        statusRank(a.status) - statusRank(b.status) ||
        (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)
    );

  return {
    medianBytesPerPartition: medianBytes,
    medianEntriesPerPartition: medianEntries,
    medianBytesPerEntry: medianBlock,
    contributingNodes: contributors.length,
    guard,
    nodes,
    flagged,
  };
}

/**
 * One history point as a coverage reading. `isUp` is "up at some point in the
 * bucket", so the space reading inside it is a real one; a node down for the
 * whole bucket has `uptime_pct === 0` and contributes nothing.
 */
export function coverageInputFromPoint(p: MetricPoint): CoverageInput {
  const total = p.data_total_bytes;
  return {
    nodeId: p.node_id,
    isUp: p.uptime_pct > 0,
    usedBytes:
      total === null || total <= 0
        ? null
        : Math.max(total - (p.data_available_bytes ?? 0), 0),
    storedPartitions: p.stored_partitions,
    rcEntries: p.rc_entries,
    resyncQueueLength: p.resync_queue_length,
  };
}

/**
 * The newest point per node, sorted by node id. A node whose samples stopped
 * keeps its last reading rather than dropping out — its absence from recent
 * buckets is an uptime question, and silently shrinking the peer set is how
 * the median guard would trip for the wrong reason.
 */
export function latestPointsByNode(
  points: readonly MetricPoint[]
): MetricPoint[] {
  const latest = new Map<string, MetricPoint>();
  for (const p of points) {
    const current = latest.get(p.node_id);
    if (!current || p.t > current.t) latest.set(p.node_id, p);
  }
  return [...latest.values()].sort((a, b) =>
    a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0
  );
}
