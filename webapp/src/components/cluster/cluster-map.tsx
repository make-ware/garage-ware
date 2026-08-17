'use client';

import { useMemo, useState } from 'react';
import type { NodeMetric } from '@garage-ware/shared';
import type { ClusterNodeItem, ClusterTimelineEvent } from '@/lib/types';
import { groupNodesByZone } from './cluster-groups';
import { NodeDetailsDialog } from './node-details-dialog';
import { ZoneGroupCard } from './zone-group-card';

interface ClusterMapProps {
  items: ClusterNodeItem[];
  replicationFactor: number;
  /** node id → latest NodeMetrics row; null while loading or unavailable. */
  latestMetrics: Map<string, NodeMetric> | null;
  /**
   * node id → open manual notes. Passing it is what puts a node "under
   * repair" in the details dialog; a page that doesn't fetch the timeline
   * simply omits it.
   */
  openEventsByNode?: Map<string, ClusterTimelineEvent[]>;
  /**
   * node id → network address. Admin pages only — passing it is what makes
   * the details dialog show an address at all.
   */
  addrByNodeId?: Map<string, string | null>;
}

/**
 * The zone-grouped cluster map: a responsive grid of zones, each holding a
 * responsive grid of node cards, with details in a dialog.
 *
 * Zones use `auto-fit` so a lone zone takes the full width instead of leaving
 * a column of dead space; nodes inside use `auto-fill` so cards stay a
 * consistent size across zones of different sizes. Both mins are wrapped in
 * `min(100%, …)` — a bare rem minimum in `minmax()` overflows any container
 * narrower than it, which is exactly the phone case this replaced.
 */
export function ClusterMap({
  items,
  replicationFactor,
  latestMetrics,
  openEventsByNode,
  addrByNodeId,
}: ClusterMapProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId
    ? (items.find((i) => i.id === selectedId) ?? null)
    : null;

  const groups = useMemo(() => groupNodesByZone(items), [items]);
  // Cluster-wide notes carry no node_id and are skipped: "under repair" is a
  // per-node state, and a note about the cluster shouldn't amber every card.
  const underRepairNodes = useMemo(
    () =>
      new Set(
        [...(openEventsByNode?.keys() ?? [])].filter(
          (nodeId) => nodeId && (openEventsByNode?.get(nodeId)?.length ?? 0) > 0
        )
      ),
    [openEventsByNode]
  );

  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No nodes in the cluster layout.
      </p>
    );
  }

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-4">
        {groups.map((group) => (
          <ZoneGroupCard
            key={group.zone}
            group={group}
            selectedId={selectedId}
            underRepairNodes={underRepairNodes}
            onSelect={setSelectedId}
          />
        ))}
      </div>
      <NodeDetailsDialog
        item={selected}
        onClose={() => setSelectedId(null)}
        replicationFactor={replicationFactor}
        latestMetrics={latestMetrics}
        openEventsByNode={openEventsByNode}
        addrByNodeId={addrByNodeId}
      />
    </>
  );
}
