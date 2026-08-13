import { describe, expect, it } from 'vitest';
import {
  assessCoverage,
  bytesPerPartition,
  coverageInputFromMetric,
  coverageInputFromPoint,
  latestPointsByNode,
  median,
  MIN_MEDIAN_BYTES_PER_PARTITION,
  MIN_PEER_READINGS,
  SHORTFALL_SEVERE,
  SHORTFALL_WARN,
  type CoverageInput,
} from './data-coverage';
import type { NodeMetric } from '@garage-ware/shared';
import type { MetricPoint } from '@/lib/types';

const GB = 1024 ** 3;

/**
 * A healthy storage node: 100 partitions holding 100 GB, so 1 GB per
 * partition and 100 rc entries per partition. Every case below is a deviation
 * from this one.
 */
function input(
  nodeId: string,
  overrides: Partial<CoverageInput> = {}
): CoverageInput {
  return {
    nodeId,
    isUp: true,
    usedBytes: 100 * GB,
    storedPartitions: 100,
    rcEntries: 10_000,
    resyncQueueLength: 0,
    ...overrides,
  };
}

/** Three healthy peers, so the MIN_PEER_READINGS guard is satisfied. */
function healthy(): CoverageInput[] {
  return [input('h1'), input('h2'), input('h3')];
}

function byId(result: ReturnType<typeof assessCoverage>, nodeId: string) {
  const node = result.nodes.find((n) => n.nodeId === nodeId);
  if (!node) throw new Error(`no coverage for ${nodeId}`);
  return node;
}

describe('median', () => {
  it('is null for an empty set', () => {
    expect(median([])).toBeNull();
  });

  it('takes the middle value when odd', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('averages the middle two when even', () => {
    expect(median([1, 3, 5, 7])).toBe(4);
  });
});

describe('bytesPerPartition', () => {
  it('divides used bytes by the partitions the layout assigned', () => {
    expect(bytesPerPartition(input('a'))).toBe(GB);
  });

  it('is null for a node that cannot contribute', () => {
    expect(bytesPerPartition(input('a', { isUp: false }))).toBeNull();
    expect(
      bytesPerPartition(input('a', { storedPartitions: null }))
    ).toBeNull();
    expect(bytesPerPartition(input('a', { storedPartitions: 0 }))).toBeNull();
    expect(bytesPerPartition(input('a', { usedBytes: null }))).toBeNull();
  });
});

describe('assessCoverage', () => {
  it('reads a uniform cluster as healthy', () => {
    const result = assessCoverage(healthy());
    expect(result.contributingNodes).toBe(3);
    expect(result.guard).toBeNull();
    expect(result.medianBytesPerPartition).toBe(GB);
    expect(result.medianEntriesPerPartition).toBe(100);
    expect(result.medianBytesPerEntry).toBeCloseTo((100 * GB) / 10_000);
    expect(result.nodes.map((n) => n.status)).toEqual(['ok', 'ok', 'ok']);
    expect(result.nodes.every((n) => n.reason === null)).toBe(true);
    expect(result.flagged).toEqual([]);
  });

  it('exposes each node bytes-per-entry as its average block size', () => {
    const result = assessCoverage(healthy());
    expect(byId(result, 'h1').bytesPerEntry).toBeCloseTo((100 * GB) / 10_000);
  });

  // The invariant the whole feature rests on: a bigger drive earns more
  // partitions, not fuller ones.
  it('reads a node with twice the partitions and twice the bytes as healthy', () => {
    const result = assessCoverage([
      input('h1'),
      input('big', {
        storedPartitions: 200,
        usedBytes: 200 * GB,
        rcEntries: 20_000,
      }),
      input('h3'),
    ]);
    expect(result.medianBytesPerPartition).toBe(GB);
    expect(byId(result, 'big').status).toBe('ok');
    expect(byId(result, 'big').shortfallPct).toBe(0);
  });

  // Zone redundancy changes how many partitions a node is given, never how
  // much one partition holds.
  it('reads a zone-constrained node with proportionally fewer bytes as healthy', () => {
    const result = assessCoverage([
      input('h1'),
      input('h2'),
      input('constrained', {
        storedPartitions: 60,
        usedBytes: 60 * GB,
        rcEntries: 6_000,
      }),
    ]);
    expect(result.nodes.every((n) => n.status === 'ok')).toBe(true);
  });

  // The estimator has to survive the outlier it is looking for. A mean would
  // land at 2/3 GB here and read the wiped node as only 33% short.
  it('takes the median, so one wiped node does not move the expectation', () => {
    const result = assessCoverage([
      input('h1'),
      input('wiped', { usedBytes: 0, rcEntries: 10_000 }),
      input('h3'),
    ]);
    expect(result.medianBytesPerPartition).toBe(GB);
    expect(byId(result, 'wiped').shortfallPct).toBe(1);
    expect(byId(result, 'wiped').status).toBe('missing-data');
  });

  it('refuses to judge fewer than MIN_PEER_READINGS contributors', () => {
    const result = assessCoverage([
      input('h1'),
      input('wiped', { usedBytes: 0 }),
    ]);
    expect(MIN_PEER_READINGS).toBe(3);
    expect(result.contributingNodes).toBe(2);
    expect(result.guard).toBe('too-few-peers');
    expect(result.nodes.every((n) => n.status === 'unknown')).toBe(true);
    expect(result.nodes.every((n) => n.reason === 'too-few-peers')).toBe(true);
    // The measurement survives the suppressed judgement.
    expect(byId(result, 'h1').bytesPerPartition).toBe(GB);
    expect(byId(result, 'h1').shortfallPct).toBeNull();
    expect(result.flagged).toEqual([]);
  });

  it('refuses to judge a cluster holding almost nothing per partition', () => {
    const tiny = MIN_MEDIAN_BYTES_PER_PARTITION / 2;
    const result = assessCoverage([
      input('h1', { usedBytes: tiny * 100 }),
      input('h2', { usedBytes: tiny * 100 }),
      input('h3', { usedBytes: 0 }),
    ]);
    expect(result.guard).toBe('cluster-too-empty');
    expect(result.nodes.every((n) => n.reason === 'cluster-too-empty')).toBe(
      true
    );
    expect(result.flagged).toEqual([]);
  });

  it('excludes a gateway as no-role without disturbing its peers', () => {
    const result = assessCoverage([
      ...healthy(),
      input('gw', { storedPartitions: 0, usedBytes: 5 * GB, rcEntries: 0 }),
    ]);
    expect(result.contributingNodes).toBe(3);
    expect(byId(result, 'gw').status).toBe('unknown');
    expect(byId(result, 'gw').reason).toBe('no-role');
    expect(result.medianBytesPerPartition).toBe(GB);
    expect(result.flagged).toEqual([]);
  });

  it('excludes a node whose layout reading is missing', () => {
    const result = assessCoverage([
      ...healthy(),
      input('unknown-layout', { storedPartitions: null }),
    ]);
    expect(result.contributingNodes).toBe(3);
    expect(byId(result, 'unknown-layout').reason).toBe('layout-unavailable');
  });

  it('excludes a down node — that alarm belongs to uptime', () => {
    const result = assessCoverage([
      ...healthy(),
      input('down', { isUp: false, usedBytes: 0 }),
    ]);
    expect(result.contributingNodes).toBe(3);
    expect(byId(result, 'down').reason).toBe('node-down');
    expect(result.flagged).toEqual([]);
  });

  it('excludes a node with no partition reading', () => {
    const result = assessCoverage([
      ...healthy(),
      input('nospace', { usedBytes: null }),
    ]);
    expect(byId(result, 'nospace').reason).toBe('no-partition-reading');
  });

  // A node whose metadata has not caught up yet does not know about the
  // blocks it is short of.
  it('calls a node short on both bytes and rc entries "rebuilding"', () => {
    const result = assessCoverage([
      ...healthy(),
      input('new', { usedBytes: 10 * GB, rcEntries: 1_000 }),
    ]);
    const node = byId(result, 'new');
    expect(node.status).toBe('rebuilding');
    expect(node.entryShortfallPct).toBeCloseTo(0.9);
  });

  // The headline case: metadata says it owns the blocks, nothing is fetching
  // them, and the bytes are not there.
  it('calls a node short on bytes with normal rc entries and an idle queue "missing-data"', () => {
    const result = assessCoverage([
      ...healthy(),
      input('wiped', {
        usedBytes: 10 * GB,
        rcEntries: 10_000,
        resyncQueueLength: 0,
      }),
    ]);
    const node = byId(result, 'wiped');
    expect(node.status).toBe('missing-data');
    expect(node.reason).toBeNull();
    expect(node.shortfallPct).toBeCloseTo(0.9);
    expect(node.blockShortfallPct).toBeCloseTo(0.9);
    expect(node.dataShortfallPct).toBeCloseTo(0.9);
    expect(node.entryShortfallPct).toBe(0);
    expect(node.severe).toBe(true);
    expect(result.flagged.map((n) => n.nodeId)).toEqual(['wiped']);
  });

  // The live case this feature was built for: a node whose metadata claims
  // MORE blocks per partition than its peers while holding fewer bytes for
  // each of them. Since bytesPerPartition = entriesPerPartition x
  // bytesPerEntry, the inflated block count deflates the per-partition figure
  // and hides the hole — 21% on that axis, 25% on the honest one.
  it('flags a node whose inflated block count masks a byte shortfall', () => {
    const result = assessCoverage([
      ...healthy(),
      input('masked', {
        // +5% blocks per partition, but only 75% of the bytes for each.
        rcEntries: 10_500,
        usedBytes: 0.75 * 1.05 * 100 * GB,
      }),
    ]);
    const node = byId(result, 'masked');
    expect(node.status).toBe('missing-data');
    // The per-partition axis alone would have read under the old 0.25 bar.
    expect(node.shortfallPct).toBeCloseTo(0.2125, 3);
    expect(node.blockShortfallPct).toBeCloseTo(0.25, 3);
    expect(node.dataShortfallPct).toBeCloseTo(0.25, 3);
    // Metadata is ahead of the pack, so this is not "still learning".
    expect(node.entryShortfallPct).toBe(0);
    expect(result.flagged.map((n) => n.nodeId)).toEqual(['masked']);
  });

  it('estimates the bytes missing from what the node own metadata implies', () => {
    const result = assessCoverage([
      ...healthy(),
      input('masked', { rcEntries: 10_000, usedBytes: 75 * GB }),
    ]);
    // 10_000 blocks x (10.7 MB expected - 8.05 MB held) = 25 GB.
    expect(byId(result, 'masked').missingBytes).toBeCloseTo(25 * GB, -6);
  });

  // Calibration, pinned so a future tweak has to argue with the measurement:
  // on a live 7-node cluster the healthy spread was under +/-2.2% on both
  // byte axes.
  it('leaves a node inside the measured healthy spread alone', () => {
    const result = assessCoverage([
      ...healthy(),
      input('jitter', { usedBytes: 97.8 * GB, rcEntries: 9_780 }),
    ]);
    expect(SHORTFALL_WARN).toBe(0.1);
    expect(SHORTFALL_SEVERE).toBe(0.25);
    expect(byId(result, 'jitter').status).toBe('ok');
    expect(byId(result, 'jitter').dataShortfallPct).toBeLessThan(
      SHORTFALL_WARN
    );
  });

  it('calls the same node "rebuilding" once its resync queue is non-empty', () => {
    const result = assessCoverage([
      ...healthy(),
      input('refilling', {
        usedBytes: 10 * GB,
        rcEntries: 10_000,
        resyncQueueLength: 5_000,
      }),
    ]);
    expect(byId(result, 'refilling').status).toBe('rebuilding');
  });

  // Fail loud: with no stats we cannot tell rebuilding from missing, and
  // under-alarming is the failure this exists to prevent.
  it('defaults a shortfall with no stats reading to "missing-data"', () => {
    const result = assessCoverage([
      ...healthy(),
      input('nostats', {
        usedBytes: 10 * GB,
        rcEntries: null,
        resyncQueueLength: null,
      }),
    ]);
    const node = byId(result, 'nostats');
    expect(node.status).toBe('missing-data');
    expect(node.entriesPerPartition).toBeNull();
    expect(node.entryShortfallPct).toBeNull();
  });

  // Non-Garage files on the data filesystem raise that node's ratio. The
  // measure is one-sided, so it never alarms — and it dilutes rather than
  // fabricates for the others.
  it('never flags an over-full node, and leaves its peers alone', () => {
    const result = assessCoverage([
      ...healthy(),
      input('junk', { usedBytes: 200 * GB }),
    ]);
    expect(byId(result, 'junk').status).toBe('ok');
    expect(byId(result, 'junk').shortfallPct).toBe(0);
    expect(result.medianBytesPerPartition).toBe(GB);
    expect(result.flagged).toEqual([]);
  });

  // A node draining out of the layout keeps its bytes but loses its
  // partitions; excluding it keeps its hugely inflated ratio out of the median.
  it('excludes a draining node and leaves the median untouched', () => {
    const result = assessCoverage([
      ...healthy(),
      input('draining', { storedPartitions: 0, usedBytes: 500 * GB }),
    ]);
    expect(byId(result, 'draining').status).toBe('unknown');
    expect(byId(result, 'draining').reason).toBe('no-role');
    expect(result.medianBytesPerPartition).toBe(GB);
  });

  it('sorts flagged nodes worst first', () => {
    const result = assessCoverage([
      ...healthy(),
      input('half', { usedBytes: 50 * GB, rcEntries: 10_000 }),
      input('tenth', { usedBytes: 10 * GB, rcEntries: 1_000 }),
    ]);
    expect(result.flagged.map((n) => n.nodeId)).toEqual(['tenth', 'half']);
  });

  it('puts missing-data ahead of rebuilding on an equal shortfall', () => {
    const result = assessCoverage([
      ...healthy(),
      // Alphabetically first, so only the status ordering can put it second.
      input('a-rebuilding', { usedBytes: 50 * GB, rcEntries: 1_000 }),
      input('z-missing', { usedBytes: 50 * GB, rcEntries: 10_000 }),
    ]);
    expect(result.flagged.map((n) => n.status)).toEqual([
      'missing-data',
      'rebuilding',
    ]);
    expect(result.flagged.map((n) => n.nodeId)).toEqual([
      'z-missing',
      'a-rebuilding',
    ]);
  });

  it('returns every input, in input order', () => {
    const result = assessCoverage([input('c'), input('a'), input('b')]);
    expect(result.nodes.map((n) => n.nodeId)).toEqual(['c', 'a', 'b']);
  });
});

function point(overrides: Partial<MetricPoint> = {}): MetricPoint {
  return {
    t: 1_000,
    node_id: 'node-a',
    samples: 1,
    uptime_pct: 100,
    resync_queue_length: 0,
    resync_errored_blocks: 0,
    rc_entries: 10_000,
    stored_partitions: 100,
    partition_size_bytes: 2 * GB,
    data_total_bytes: 500 * GB,
    data_available_bytes: 400 * GB,
    meta_total_bytes: 10 * GB,
    meta_available_bytes: 9 * GB,
    ...overrides,
  };
}

describe('coverageInputFromPoint', () => {
  it('derives used bytes from the partition totals', () => {
    expect(coverageInputFromPoint(point())).toEqual({
      nodeId: 'node-a',
      isUp: true,
      usedBytes: 100 * GB,
      storedPartitions: 100,
      rcEntries: 10_000,
      resyncQueueLength: 0,
    });
  });

  it('treats a missing partition reading as no reading, never zero bytes', () => {
    const result = coverageInputFromPoint(
      point({ data_total_bytes: null, data_available_bytes: null })
    );
    expect(result.usedBytes).toBeNull();
  });

  // Up at some point in the bucket, so the space reading inside it is real.
  it('counts any uptime in the bucket as up', () => {
    expect(coverageInputFromPoint(point({ uptime_pct: 25 })).isUp).toBe(true);
    expect(coverageInputFromPoint(point({ uptime_pct: 0 })).isUp).toBe(false);
  });

  it('passes a null layout reading through as null, and a gateway as 0', () => {
    expect(
      coverageInputFromPoint(point({ stored_partitions: null }))
        .storedPartitions
    ).toBeNull();
    expect(
      coverageInputFromPoint(point({ stored_partitions: 0 })).storedPartitions
    ).toBe(0);
  });
});

function metric(overrides: Partial<NodeMetric> = {}): NodeMetric {
  return {
    id: 'rec1',
    collectionId: 'pb_nodemetrics4x7z',
    collectionName: 'NodeMetrics',
    created: '2026-08-12 12:00:00.000Z',
    updated: '2026-08-12 12:00:00.000Z',
    node_id: 'node-a',
    node_hostname: 'vault-01',
    node_zone: 'dc1',
    is_up: true,
    node_stats_ok: true,
    resync_queue_length: 0,
    resync_errored_blocks: 0,
    rc_entries: 10_000,
    layout_ok: true,
    stored_partitions: 100,
    partition_size_bytes: 2 * GB,
    role_ok: true,
    role_capacity_bytes: 500 * GB,
    node_tags: 'name:vault-01',
    layout_version: 12,
    garage_version: '2.3.0',
    data_total_bytes: 500 * GB,
    data_available_bytes: 400 * GB,
    meta_total_bytes: 10 * GB,
    meta_available_bytes: 9 * GB,
    ...overrides,
  } as NodeMetric;
}

describe('coverageInputFromMetric', () => {
  it('derives used bytes from the stored partition totals', () => {
    expect(coverageInputFromMetric(metric())).toEqual({
      nodeId: 'node-a',
      isUp: true,
      usedBytes: 100 * GB,
      storedPartitions: 100,
      rcEntries: 10_000,
      resyncQueueLength: 0,
    });
  });

  it('reads a zero partition total as no reading, never zero bytes', () => {
    // A 0 that means "no reading" reaching assessCoverage would be judged as a
    // real one — the whole reason the raw row cannot be passed through as-is.
    expect(
      coverageInputFromMetric(
        metric({ data_total_bytes: 0, data_available_bytes: 0 })
      ).usedBytes
    ).toBeNull();
  });

  it('voids the layout reading when layout_ok is false', () => {
    const result = coverageInputFromMetric(
      metric({ layout_ok: false, stored_partitions: 0 })
    );
    expect(result.storedPartitions).toBeNull();
  });

  it('keeps a gateway 0 under layout_ok, which is a real reading', () => {
    expect(
      coverageInputFromMetric(metric({ stored_partitions: 0 })).storedPartitions
    ).toBe(0);
  });

  it('voids the resync counters when node_stats_ok is false', () => {
    const result = coverageInputFromMetric(
      metric({ node_stats_ok: false, rc_entries: 0, resync_queue_length: 0 })
    );
    expect(result.rcEntries).toBeNull();
    expect(result.resyncQueueLength).toBeNull();
  });

  it('carries is_up straight through', () => {
    expect(coverageInputFromMetric(metric({ is_up: false })).isUp).toBe(false);
  });
});

describe('latestPointsByNode', () => {
  it('keeps the newest point per node, sorted by node id', () => {
    const result = latestPointsByNode([
      point({ node_id: 'b', t: 10 }),
      point({ node_id: 'a', t: 20 }),
      point({ node_id: 'b', t: 30 }),
      point({ node_id: 'a', t: 5 }),
    ]);
    expect(result.map((p) => [p.node_id, p.t])).toEqual([
      ['a', 20],
      ['b', 30],
    ]);
  });

  // A node whose samples stopped keeps its last reading — dropping it would
  // shrink the peer set and trip the median guard for the wrong reason.
  it('keeps a node whose samples stopped early', () => {
    const result = latestPointsByNode([
      point({ node_id: 'a', t: 100 }),
      point({ node_id: 'stale', t: 1 }),
    ]);
    expect(result.map((p) => p.node_id)).toEqual(['a', 'stale']);
  });
});
