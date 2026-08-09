import type { ClusterNodeItem } from '@/lib/types';

/**
 * Pure grouping for the cluster map: turns the /cluster/nodes payload into
 * zones, each holding its sorted nodes and the two totals the zone header
 * shows. No React, no fetching, no geometry — the layout itself is CSS grid,
 * so all that is left to compute is *what goes where*, which is testable.
 *
 * This replaced a React Flow canvas whose positions were arithmetic on fixed
 * card pixels. That map could not reflow: every size was baked into the node
 * geometry and the whole thing was then scaled to fit a square frame, so on a
 * phone it became unreadably small rather than wrapping.
 */

export const NO_ZONE_LABEL = 'no zone';

export interface ZoneGroup {
  /** The raw zone key — '' for an unzoned node. Stable across renders. */
  zone: string;
  /** Display label — the raw zone, or NO_ZONE_LABEL for ''. */
  label: string;
  /** The zone's nodes, sorted by label. */
  items: ClusterNodeItem[];
  /** Sum of declared (layout) capacities; null capacities count as 0. */
  capacityBytes: number;
  /** Sum of reported data-partition sizes; unreported nodes count as 0. */
  reportedBytes: number;
}

/** The label idiom used across the app for Garage nodes. */
export function nodeLabelFor(node: {
  hostname?: string | null;
  id: string;
}): string {
  return node.hostname || `${node.id.slice(0, 12)}…`;
}

/** Zones sorted alphabetically, nodes sorted by label within each. */
export function groupNodesByZone(
  items: readonly ClusterNodeItem[]
): ZoneGroup[] {
  const byZone = new Map<string, ClusterNodeItem[]>();
  for (const item of items) {
    const zone = item.zone ?? '';
    const list = byZone.get(zone);
    if (list) {
      list.push(item);
    } else {
      byZone.set(zone, [item]);
    }
  }

  return [...byZone.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((zone) => {
      const zoneItems = [...(byZone.get(zone) ?? [])].sort((a, b) =>
        nodeLabelFor(a).localeCompare(nodeLabelFor(b))
      );
      return {
        zone,
        label: zone || NO_ZONE_LABEL,
        items: zoneItems,
        capacityBytes: zoneItems.reduce(
          (sum, item) => sum + (item.capacity ?? 0),
          0
        ),
        reportedBytes: zoneItems.reduce(
          (sum, item) => sum + (item.diskTotalBytes ?? 0),
          0
        ),
      };
    });
}
