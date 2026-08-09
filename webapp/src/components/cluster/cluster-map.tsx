'use client';

import { useMemo, useState } from 'react';
import type { NodeMetric } from '@garage-ware/shared';
import type { ClusterNodeItem } from '@/lib/types';
import { groupNodesByZone } from './cluster-groups';
import { NodeDetailsDialog } from './node-details-dialog';
import { ZoneGroupCard } from './zone-group-card';

interface ClusterMapProps {
  items: ClusterNodeItem[];
  replicationFactor: number;
  /** node id → latest NodeMetrics row; null while loading or unavailable. */
  latestMetrics: Map<string, NodeMetric> | null;
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
  addrByNodeId,
}: ClusterMapProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId
    ? (items.find((i) => i.id === selectedId) ?? null)
    : null;

  const groups = useMemo(() => groupNodesByZone(items), [items]);

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
            onSelect={setSelectedId}
          />
        ))}
      </div>
      <NodeDetailsDialog
        item={selected}
        onClose={() => setSelectedId(null)}
        replicationFactor={replicationFactor}
        latestMetrics={latestMetrics}
        addrByNodeId={addrByNodeId}
      />
    </>
  );
}
