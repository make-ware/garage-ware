'use client';

import { formatCapacity } from '@/lib/format';
import { GarageNodeCard } from './garage-node-card';
import type { ZoneGroup } from './cluster-groups';

/**
 * One zone: a labelled box holding its node cards in an auto-filling grid.
 *
 * The inner grid is `auto-fill` rather than `auto-fit` on purpose — auto-fit
 * collapses empty tracks, so a zone holding a single node would stretch that
 * card across the whole zone while its four-node neighbour showed normal ones.
 * auto-fill keeps every card the same size whatever the zone holds.
 *
 * The two totals mirror the cards: declared layout capacity, and what the
 * zone's data partitions actually report.
 */
export function ZoneGroupCard({
  group,
  selectedId,
  onSelect,
}: {
  group: ZoneGroup;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
}) {
  return (
    <section
      aria-label={`Zone ${group.label}`}
      className="rounded-lg border border-dashed border-border bg-muted/30 p-4"
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="text-sm font-semibold">{group.label}</h2>
        <span className="text-xs text-muted-foreground">
          {group.items.length} {group.items.length === 1 ? 'node' : 'nodes'}
          {group.capacityBytes > 0 &&
            ` · ${formatCapacity(group.capacityBytes)} layout`}
          {group.reportedBytes > 0 &&
            ` · ${formatCapacity(group.reportedBytes)} reported`}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-3">
        {group.items.map((item) => (
          <GarageNodeCard
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}
