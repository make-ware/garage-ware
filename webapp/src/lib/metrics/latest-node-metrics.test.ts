import { describe, expect, it } from 'vitest';
import type { NodeMetric } from '@garage-ware/shared';
import type { TypedPocketBase } from '@/lib/types';
import { fetchLatestNodeMetrics } from './latest-node-metrics';

function metric(nodeId: string, created: string): NodeMetric {
  return {
    id: `m-${nodeId}-${created}`,
    created,
    updated: created,
    node_id: nodeId,
    node_hostname: '',
    node_zone: '',
    is_up: true,
    node_stats_ok: true,
    resync_queue_length: 0,
    resync_errored_blocks: 0,
    data_total_bytes: 0,
    data_available_bytes: 0,
    meta_total_bytes: 0,
    meta_available_bytes: 0,
  } as NodeMetric;
}

interface RecordedCall {
  page: number;
  perPage: number;
  filter?: string;
  sort?: string;
}

function fakePb(rowsByNode: Record<string, NodeMetric[]>): {
  pb: TypedPocketBase;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const pb = {
    collection: (name: string) => {
      if (name !== 'NodeMetrics') throw new Error(`unexpected ${name}`);
      return {
        getList: async (
          page: number,
          perPage: number,
          options: { filter?: string; sort?: string } = {}
        ) => {
          calls.push({ page, perPage, ...options });
          const match = /node_id = "([^"]+)"/.exec(options.filter ?? '');
          const rows = match ? (rowsByNode[match[1]] ?? []) : [];
          const sorted = [...rows].sort((a, b) =>
            b.created.localeCompare(a.created)
          );
          const items = sorted.slice(0, perPage);
          return {
            items,
            page,
            perPage,
            totalItems: rows.length,
            totalPages: Math.max(Math.ceil(rows.length / perPage), 1),
          };
        },
      };
    },
  } as unknown as TypedPocketBase;
  return { pb, calls };
}

describe('fetchLatestNodeMetrics', () => {
  it('returns the newest row per node and omits nodes with no samples', async () => {
    const { pb } = fakePb({
      a: [
        metric('a', '2026-08-08 09:45:00.000Z'),
        metric('a', '2026-08-08 10:00:00.000Z'),
      ],
      b: [metric('b', '2026-08-01 00:00:00.000Z')],
    });
    const latest = await fetchLatestNodeMetrics(pb, ['a', 'b', 'c']);
    expect(latest.get('a')?.created).toBe('2026-08-08 10:00:00.000Z');
    // an old row is still the latest — age must not disqualify a node
    expect(latest.get('b')?.created).toBe('2026-08-01 00:00:00.000Z');
    expect(latest.has('c')).toBe(false);
    expect(latest.size).toBe(2);
  });

  it('issues one newest-first single-row query per node', async () => {
    const { pb, calls } = fakePb({ a: [metric('a', '2026-08-08')] });
    await fetchLatestNodeMetrics(pb, ['a', 'b']);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.page).toBe(1);
      expect(call.perPage).toBe(1);
      expect(call.sort).toBe('-created');
      expect(call.filter).toMatch(/node_id = "(a|b)"/);
    }
  });

  it('returns an empty map for no nodes without touching PocketBase', async () => {
    const { pb, calls } = fakePb({});
    const latest = await fetchLatestNodeMetrics(pb, []);
    expect(latest.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
