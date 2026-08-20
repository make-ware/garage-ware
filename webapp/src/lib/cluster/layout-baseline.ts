import type { NodeMetric } from '@garage-ware/shared';
import { PARTITION_COUNT, type SimResult } from './layout-sim';
import type { LiveRole } from './layout-draft';

/**
 * Where the planner's "before" partition counts come from.
 *
 * The movement figure the planner prints — "N partitions would move" — is the
 * number an operator would actually act on, so a wrong baseline is worse than
 * no baseline. Three sources, in descending order of trust:
 *
 * 1. **`garage`** — Garage's own `storedPartitions`, sampled into `NodeMetrics`
 *    every 15 minutes by the scrape cron. No new endpoint and no admin-API
 *    call: those rows are already keyed by node key and already readable by any
 *    signed-in user.
 * 2. **`simulated`** — this module's own answer for the *unmodified* layout,
 *    used when the samples cannot be trusted. Labelled as such in the UI,
 *    because a delta against an estimate is an estimate of a delta.
 * 3. **`none`** — no baseline at all. The delta column disappears and the page
 *    says why, rather than printing zeros that read as "nothing moves".
 *
 * The rejection rules exist because a sample is up to 15 minutes old:
 *
 * - **`layout_ok` gates the reading.** Under that gate `stored_partitions === 0`
 *   is a *real* answer (a gateway); without it, a cluster-wide layout failure
 *   wrote 0 for every node and would read back as "everything moves".
 * - **`layout_version` must match** the layout on screen. A sample from the
 *   previous version describes a different assignment entirely.
 * - **The counts must sum to `PARTITION_COUNT × replicationFactor`.** That is
 *   the one check that catches a node simply missing from the samples, which
 *   no per-row gate can see.
 */
export type BaselineSource = 'garage' | 'simulated' | 'none';

export type BaselineRejection =
  'no-samples' | 'ungated' | 'stale-layout-version' | 'wrong-total';

export interface LayoutBaseline {
  source: BaselineSource;
  /** Partition counts by node key; `null` when `source` is `none`. */
  partitions: Record<string, number> | null;
  /** Why Garage's own counts were not used. `null` when they were. */
  rejected: BaselineRejection | null;
}

export interface BaselineInput {
  roles: readonly LiveRole[];
  /** Latest `NodeMetrics` row per node key, or `null` if the read failed. */
  metrics: ReadonlyMap<string, NodeMetric> | null;
  layoutVersion: number;
  replicationFactor: number;
  /** This module's own answer for the layout exactly as it stands. */
  liveSimulation: SimResult;
}

export function resolveBaseline(input: BaselineInput): LayoutBaseline {
  const { roles, metrics, layoutVersion, replicationFactor, liveSimulation } =
    input;

  const fallback = (rejected: BaselineRejection): LayoutBaseline =>
    liveSimulation.ok
      ? {
          source: 'simulated',
          partitions: Object.fromEntries(
            liveSimulation.estimated.nodes.map((n) => [
              n.id,
              n.estimatedPartitions,
            ])
          ),
          rejected,
        }
      : { source: 'none', partitions: null, rejected };

  if (!metrics || metrics.size === 0) return fallback('no-samples');

  const partitions: Record<string, number> = {};
  let total = 0;
  for (const role of roles) {
    const metric = metrics.get(role.id);
    if (!metric) return fallback('no-samples');
    if (!metric.layout_ok || !metric.role_ok) return fallback('ungated');
    if (metric.layout_version !== layoutVersion) {
      return fallback('stale-layout-version');
    }
    partitions[role.id] = metric.stored_partitions;
    total += metric.stored_partitions;
  }

  if (total !== PARTITION_COUNT * replicationFactor) {
    return fallback('wrong-total');
  }
  return { source: 'garage', partitions, rejected: null };
}

/** One sentence naming why Garage's own counts were set aside. */
export const BASELINE_REJECTION_COPY: Record<BaselineRejection, string> = {
  'no-samples':
    'no recent per-node metrics for every node in the layout (the scrape runs every 15 minutes)',
  ungated:
    'the latest metrics were recorded while Garage could not report the layout',
  'stale-layout-version':
    'the latest metrics describe an older layout version than the one on screen',
  'wrong-total':
    'the sampled partition counts do not add up to the full ring, so at least one node is missing from them',
};
