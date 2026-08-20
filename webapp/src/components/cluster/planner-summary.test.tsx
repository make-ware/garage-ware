import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlannerSummary } from './planner-summary';
import { simulateLayout, type SimSuccess } from '@/lib/cluster/layout-sim';

const MB = 1_000_000;

function threeZones(previous?: Record<string, number>): SimSuccess {
  const result = simulateLayout({
    nodes: [
      { id: 'n1', zone: 'dc1', capacityBytes: 1000 * MB },
      { id: 'n2', zone: 'dc2', capacityBytes: 1000 * MB },
      { id: 'n3', zone: 'dc3', capacityBytes: 1000 * MB },
    ],
    replicationFactor: 3,
    zoneRedundancy: { mode: 'maximum' },
    previous,
  });
  if (!result.ok) throw new Error('fixture is infeasible');
  return result;
}

const base = {
  result: threeZones({ n1: 256, n2: 256, n3: 256 }),
  baselineCapacityBytes: 1000 * MB,
  conformance: { kind: 'unknown' } as const,
  baselineSource: 'garage' as const,
};

describe('PlannerSummary', () => {
  it('separates the exact figures from the estimated ones', () => {
    // The badge is the contract: partition size and capacity reproduce Garage
    // exactly, the per-node split does not.
    render(<PlannerSummary {...base} />);
    expect(screen.getByText('Exact')).toBeDefined();
    expect(screen.getByText('3.9 MB')).toBeDefined();
    expect(screen.getByText('256 partitions')).toBeDefined();
  });

  it('calls the movement figure a lower bound', () => {
    // A node whose count is unchanged can still swap which partitions it
    // holds, and no aggregate can see that.
    const { container } = render(<PlannerSummary {...base} />);
    expect(container.textContent).toContain('lower bound');
  });

  it('says when there is no baseline rather than printing a zero', () => {
    const { container } = render(
      <PlannerSummary {...base} result={threeZones()} baselineSource="none" />
    );
    expect(container.textContent).toContain('cannot be estimated');
  });

  it('marks a movement figure measured against an estimated baseline', () => {
    const { container } = render(
      <PlannerSummary {...base} baselineSource="simulated" />
    );
    expect(container.textContent).toContain('estimated baseline');
  });

  it('reports the capacity change against the live layout', () => {
    const { container } = render(
      <PlannerSummary {...base} baselineCapacityBytes={500 * MB} />
    );
    expect(container.textContent).toContain('+500 MB vs. now');
  });

  it('badges agreement with the operator’s own cluster', () => {
    render(
      <PlannerSummary
        {...base}
        conformance={{ kind: 'match', partitionSizeBytes: 3_906_250 }}
      />
    );
    expect(screen.getByText('Matches this cluster')).toBeDefined();
  });

  it('renders no conformance badge when there is nothing to compare', () => {
    render(<PlannerSummary {...base} />);
    expect(screen.queryByText('Matches this cluster')).toBeNull();
    expect(screen.queryByText('Differs from this cluster')).toBeNull();
  });
});
