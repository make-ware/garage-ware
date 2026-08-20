import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlannerZoneTable } from './planner-zone-table';
import { simulateLayout } from '@/lib/cluster/layout-sim';

const TB = 1_000_000_000_000;

function zonesFor(capacities: [string, string, number][]) {
  const result = simulateLayout({
    nodes: capacities.map(([id, zone, capacityBytes]) => ({
      id,
      zone,
      capacityBytes,
    })),
    replicationFactor: 3,
    zoneRedundancy: { mode: 'maximum' },
  });
  if (!result.ok) throw new Error('fixture is infeasible');
  return result.estimated.zones;
}

describe('PlannerZoneTable', () => {
  it('names the zone that alone bounds the cluster', () => {
    // This is the panel `garage layout show` does not give you: not what the
    // partition size is, but why.
    render(
      <PlannerZoneTable
        zones={zonesFor([
          ['a', 'dc1', 1 * TB],
          ['b', 'dc2', 50 * TB],
          ['c', 'dc3', 50 * TB],
        ])}
      />
    );
    expect(screen.getAllByText('Limiting')).toHaveLength(1);
  });

  it('marks nothing when every zone would have to grow together', () => {
    render(
      <PlannerZoneTable
        zones={zonesFor([
          ['a', 'dc1', 16 * TB],
          ['b', 'dc2', 16 * TB],
          ['c', 'dc3', 16 * TB],
        ])}
      />
    );
    expect(screen.queryByText('Limiting')).toBeNull();
  });

  it('shows each zone’s partitions against its ceiling', () => {
    const { container } = render(
      <PlannerZoneTable
        zones={zonesFor([
          ['a', 'dc1', 16 * TB],
          ['b', 'dc2', 16 * TB],
          ['c', 'dc3', 16 * TB],
        ])}
      />
    );
    expect(container.textContent).toContain('/ 256');
  });
});
