import type { NodeMetric } from '@garage-ware/shared';

export interface PartitionSample {
  totalBytes: number;
  availableBytes: number;
  /** Derived: total − available. There is no stored "used" field. */
  usedBytes: number;
}

export interface ResyncSample {
  queueLength: number;
  erroredBlocks: number;
}

/**
 * A NodeMetrics row translated into what may actually be shown. `null` means
 * "no reading" — a gap in the UI, never a zero.
 */
export interface NodeSample {
  /** PB timestamp of the sample — render via formatPbDateTime. */
  sampledAt: string;
  isUp: boolean;
  dataPartition: PartitionSample | null;
  metaPartition: PartitionSample | null;
  resync: ResyncSample | null;
}

function partition(
  totalBytes: number,
  availableBytes: number
): PartitionSample | null {
  // A real partition always has total > 0; 0 means "no partition data"
  // (e.g. a gateway node) — PB number fields cannot hold null.
  if (totalBytes <= 0) return null;
  return {
    totalBytes,
    availableBytes,
    usedBytes: Math.max(totalBytes - availableBytes, 0),
  };
}

/**
 * Encodes the NodeMetrics null conventions once (see the schema docblock in
 * shared/src/schema/node-metric.ts) so no component re-derives them:
 * `node_stats_ok === false` voids the resync counters, and a zero
 * `*_total_bytes` voids the partition.
 */
export function describeSample(m: NodeMetric): NodeSample {
  return {
    sampledAt: m.created,
    isUp: m.is_up,
    dataPartition: partition(m.data_total_bytes, m.data_available_bytes),
    metaPartition: partition(m.meta_total_bytes, m.meta_available_bytes),
    resync: m.node_stats_ok
      ? {
          queueLength: m.resync_queue_length,
          erroredBlocks: m.resync_errored_blocks,
        }
      : null,
  };
}
