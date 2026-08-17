import { describe, expect, it } from 'vitest';
// A Goja CommonJS module from the PocketBase hooks, deliberately imported
// across the workspace boundary so the bucketing the /dashboard/metrics charts
// rely on is pinned by a test. Its top level touches no PocketBase globals,
// so it loads fine here; it carries no types, hence the local interfaces.
import {
  bucketHistory,
  RANGES,
} from '../../../../pocketbase/pb_hooks/lib/node-metrics.js';

interface Row {
  node_id: string;
  node_hostname?: string;
  node_zone?: string;
  is_up: boolean;
  node_stats_ok: boolean;
  resync_queue_length: number;
  resync_errored_blocks: number;
  rc_entries: number;
  layout_ok: boolean;
  stored_partitions: number;
  partition_size_bytes: number;
  data_total_bytes: number;
  data_available_bytes: number;
  meta_total_bytes: number;
  meta_available_bytes: number;
  created: string;
}

interface Point {
  t: number;
  node_id: string;
  samples: number;
  uptime_pct: number;
  resync_queue_length: number | null;
  resync_errored_blocks: number | null;
  rc_entries: number | null;
  stored_partitions: number | null;
  partition_size_bytes: number | null;
  data_total_bytes: number | null;
  data_available_bytes: number | null;
  meta_total_bytes: number | null;
  meta_available_bytes: number | null;
}

interface History {
  nodes: Array<{ node_id: string; node_zone: string }>;
  points: Point[];
}

function row(overrides: Partial<Row> & { created: string }): Row {
  return {
    node_id: 'node-a',
    node_hostname: 'alpha',
    node_zone: 'pdx1',
    is_up: true,
    node_stats_ok: true,
    resync_queue_length: 0,
    resync_errored_blocks: 0,
    rc_entries: 500,
    layout_ok: true,
    stored_partitions: 64,
    partition_size_bytes: 2000,
    data_total_bytes: 1000,
    data_available_bytes: 400,
    meta_total_bytes: 100,
    meta_available_bytes: 90,
    ...overrides,
  };
}

// PB autodate format: space separator, trailing Z.
const T0 = '2026-08-08 12:00:00.000Z';
const T5 = '2026-08-08 12:05:00.000Z';
const T20 = '2026-08-08 12:20:00.000Z';
const t0Ms = Date.parse('2026-08-08T12:00:00.000Z');

describe('bucketHistory', () => {
  it('groups samples into bucket-start-aligned buckets per node', () => {
    const result = bucketHistory(
      [row({ created: T0 }), row({ created: T5 }), row({ created: T20 })],
      900
    ) as History;

    expect(result.points).toHaveLength(2);
    expect(result.points[0]).toMatchObject({
      t: t0Ms,
      node_id: 'node-a',
      samples: 2,
    });
    expect(result.points[1]).toMatchObject({
      t: t0Ms + 900_000,
      samples: 1,
    });
  });

  it('computes uptime as the share of up samples in the bucket', () => {
    const result = bucketHistory(
      [row({ created: T0, is_up: true }), row({ created: T5, is_up: false })],
      900
    ) as History;

    expect(result.points[0].uptime_pct).toBe(50);
  });

  it('nulls resync fields when no sample in the bucket has stats', () => {
    const result = bucketHistory(
      [row({ created: T0, node_stats_ok: false, resync_queue_length: 7 })],
      900
    ) as History;

    // A failed stats call must chart as a gap, never as "queue dropped to 0"
    // — and certainly not as the stale stored number.
    expect(result.points[0].resync_queue_length).toBeNull();
    expect(result.points[0].resync_errored_blocks).toBeNull();
  });

  it('averages resync fields over stats-carrying samples only', () => {
    const result = bucketHistory(
      [
        row({ created: T0, resync_queue_length: 10 }),
        row({ created: T5, node_stats_ok: false, resync_queue_length: 999 }),
      ],
      900
    ) as History;

    expect(result.points[0].resync_queue_length).toBe(10);
  });

  it('averages rc_entries over stats-carrying samples only', () => {
    // Same gate as the resync counters — one GetNodeStatistics call, so one
    // gate covers all three.
    const result = bucketHistory(
      [
        row({ created: T0, rc_entries: 100 }),
        row({ created: T5, node_stats_ok: false, rc_entries: 999999 }),
      ],
      900
    ) as History;

    expect(result.points[0].rc_entries).toBe(100);
  });

  it('nulls the layout fields when no sample in the bucket has layout_ok', () => {
    // The whole point of the layout_ok gate: a failed GetClusterLayout must
    // chart as a gap, not as "this node holds no partitions".
    const result = bucketHistory(
      [
        row({
          created: T0,
          layout_ok: false,
          stored_partitions: 64,
          partition_size_bytes: 2000,
        }),
      ],
      900
    ) as History;

    expect(result.points[0].stored_partitions).toBeNull();
    expect(result.points[0].partition_size_bytes).toBeNull();
  });

  it('emits 0, not null, stored partitions for a gateway under layout_ok', () => {
    // The asymmetry that justifies the gate: 0 under layout_ok is a reading —
    // "this node holds no partitions" — and must not be confused with the gap
    // above.
    const result = bucketHistory(
      [row({ created: T0, layout_ok: true, stored_partitions: 0 })],
      900
    ) as History;

    expect(result.points[0].stored_partitions).toBe(0);
  });

  it('averages a mid-bucket layout change into a fractional partition count', () => {
    // Correct rather than surprising: the node genuinely held 64 partitions
    // and then 32.
    const result = bucketHistory(
      [
        row({ created: T0, stored_partitions: 64 }),
        row({ created: T5, stored_partitions: 32 }),
      ],
      900
    ) as History;

    expect(result.points[0].stored_partitions).toBe(48);
  });

  it('gates the layout fields independently of the partition-space ones', () => {
    // A down node keeps its layout role but reports no space; a gateway is
    // the reverse. One gate could not express both.
    const result = bucketHistory(
      [
        row({
          created: T0,
          is_up: false,
          data_total_bytes: 0,
          data_available_bytes: 0,
        }),
      ],
      900
    ) as History;

    expect(result.points[0].data_total_bytes).toBeNull();
    expect(result.points[0].stored_partitions).toBe(64);
  });

  it('nulls partition fields when total is 0 (gateway node convention)', () => {
    const result = bucketHistory(
      [
        row({
          created: T0,
          data_total_bytes: 0,
          data_available_bytes: 0,
          meta_total_bytes: 0,
          meta_available_bytes: 0,
        }),
      ],
      900
    ) as History;

    expect(result.points[0].data_total_bytes).toBeNull();
    expect(result.points[0].meta_total_bytes).toBeNull();
  });

  it('keeps nodes separate and labels each with its latest identity', () => {
    const result = bucketHistory(
      [
        row({ created: T0, node_id: 'node-b', node_zone: 'old-zone' }),
        row({ created: T5, node_id: 'node-b', node_zone: 'new-zone' }),
        row({ created: T0 }),
      ],
      900
    ) as History;

    // Sorted by node_id for stable chart color assignment.
    expect(result.nodes.map((n) => n.node_id)).toEqual(['node-a', 'node-b']);
    expect(result.nodes[1].node_zone).toBe('new-zone');
    expect(result.points).toHaveLength(2);
  });

  it('never labels a node with its hostname', () => {
    // A node is identified by its name or its key. The column survives on the
    // row for the event differ; it must not reach this payload, which any
    // signed-in user can read.
    const result = bucketHistory(
      [row({ created: T0, node_id: 'node-a', node_hostname: 'garage-1' })],
      900
    ) as History;

    expect(result.nodes[0]).not.toHaveProperty('node_hostname');
  });

  it('serves every range the history endpoint advertises', () => {
    expect(Object.keys(RANGES as Record<string, unknown>)).toEqual([
      '6h',
      '24h',
      '7d',
      '30d',
    ]);
  });
});
