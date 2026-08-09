import { describe, expect, it } from 'vitest';
import type { NodeMetric } from '@garage-ware/shared';
import { describeSample } from './node-sample';

function metric(overrides: Partial<NodeMetric> = {}): NodeMetric {
  return {
    id: 'm1',
    created: '2026-08-08 10:00:00.000Z',
    updated: '2026-08-08 10:00:00.000Z',
    node_id: 'node-a',
    node_hostname: 'garage-1',
    node_zone: 'z1',
    is_up: true,
    node_stats_ok: true,
    resync_queue_length: 3,
    resync_errored_blocks: 1,
    data_total_bytes: 1000,
    data_available_bytes: 400,
    meta_total_bytes: 100,
    meta_available_bytes: 90,
    ...overrides,
  } as NodeMetric;
}

describe('describeSample', () => {
  it('passes a fully-populated row through, deriving used bytes', () => {
    const sample = describeSample(metric());
    expect(sample).toEqual({
      sampledAt: '2026-08-08 10:00:00.000Z',
      isUp: true,
      dataPartition: { totalBytes: 1000, availableBytes: 400, usedBytes: 600 },
      metaPartition: { totalBytes: 100, availableBytes: 90, usedBytes: 10 },
      resync: { queueLength: 3, erroredBlocks: 1 },
    });
  });

  it('voids the resync counters when node_stats_ok is false, even if nonzero', () => {
    const sample = describeSample(
      metric({
        node_stats_ok: false,
        resync_queue_length: 42,
        resync_errored_blocks: 7,
      })
    );
    expect(sample.resync).toBeNull();
  });

  it('treats a zero total as "no partition data", never a 0-byte partition', () => {
    const sample = describeSample(
      metric({
        data_total_bytes: 0,
        data_available_bytes: 0,
        meta_total_bytes: 0,
        meta_available_bytes: 0,
      })
    );
    expect(sample.dataPartition).toBeNull();
    expect(sample.metaPartition).toBeNull();
  });

  it('clamps derived used bytes at zero', () => {
    const sample = describeSample(
      metric({ data_total_bytes: 100, data_available_bytes: 150 })
    );
    expect(sample.dataPartition?.usedBytes).toBe(0);
  });
});
