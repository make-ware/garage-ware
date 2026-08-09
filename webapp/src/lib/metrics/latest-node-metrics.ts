import { NodeMetricMutator } from '@garage-ware/shared/mutators';
import type { NodeMetric } from '@garage-ware/shared';
import type { TypedPocketBase } from '@/lib/types';

/**
 * The most recent NodeMetrics row for each of the given nodes, keyed by
 * node id. Nodes with no samples are simply absent from the map.
 *
 * Deliberately one indexed point-read per node (the `(node_id, created)`
 * index serves `sort: -created` + `perPage: 1` directly) rather than a
 * windowed query deduped client-side: a time window would silently drop a
 * node whose cron samples stopped — exactly the node worth inspecting. Node
 * counts are single digits, so the parallel fan-out is trivial.
 *
 * Client-safe on purpose: the NodeMetrics list rule admits any signed-in
 * user, so the cluster map reads this straight from the browser.
 */
export async function fetchLatestNodeMetrics(
  pb: TypedPocketBase,
  nodeIds: readonly string[]
): Promise<Map<string, NodeMetric>> {
  const metrics = new NodeMetricMutator(pb);
  const pages = await Promise.all(
    nodeIds.map((nodeId) => metrics.search(1, 1, { nodeId }))
  );
  const latest = new Map<string, NodeMetric>();
  pages.forEach((page, i) => {
    const row = page.items[0];
    if (row) latest.set(nodeIds[i], row);
  });
  return latest;
}
