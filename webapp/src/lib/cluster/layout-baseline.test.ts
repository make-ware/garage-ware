import { describe, expect, it } from 'vitest';
import type { NodeMetric } from '@garage-ware/shared';
import { resolveBaseline, type BaselineInput } from './layout-baseline';
import { simulateLayout, type SimResult } from './layout-sim';
import type { LiveRole } from './layout-draft';

const TB = 1_000_000_000_000;

const ROLES: LiveRole[] = [
  { id: 'n1', zone: 'dc1', capacity: 16 * TB, tags: [] },
  { id: 'n2', zone: 'dc2', capacity: 16 * TB, tags: [] },
  { id: 'n3', zone: 'dc3', capacity: 16 * TB, tags: [] },
];

const LIVE_SIM: SimResult = simulateLayout({
  nodes: ROLES.map((r) => ({
    id: r.id,
    zone: r.zone,
    capacityBytes: r.capacity ?? null,
  })),
  replicationFactor: 3,
  zoneRedundancy: { mode: 'maximum' },
});

/** Only the fields `resolveBaseline` reads; the collection has twenty more. */
function metric(overrides: Partial<NodeMetric>): NodeMetric {
  return {
    layout_ok: true,
    role_ok: true,
    layout_version: 7,
    stored_partitions: 256,
    ...overrides,
  } as NodeMetric;
}

function metrics(overrides: Partial<NodeMetric> = {}) {
  return new Map(ROLES.map((r) => [r.id, metric(overrides)]));
}

function input(over: Partial<BaselineInput> = {}): BaselineInput {
  return {
    roles: ROLES,
    metrics: metrics(),
    layoutVersion: 7,
    replicationFactor: 3,
    liveSimulation: LIVE_SIM,
    ...over,
  };
}

describe('resolveBaseline', () => {
  it('prefers Garage’s own partition counts', () => {
    expect(resolveBaseline(input())).toEqual({
      source: 'garage',
      partitions: { n1: 256, n2: 256, n3: 256 },
      rejected: null,
    });
  });

  it('falls back to a simulated baseline when a sample is missing', () => {
    const partial = metrics();
    partial.delete('n2');
    const result = resolveBaseline(input({ metrics: partial }));
    expect(result.source).toBe('simulated');
    expect(result.rejected).toBe('no-samples');
    expect(result.partitions).toEqual({ n1: 256, n2: 256, n3: 256 });
  });

  it('rejects samples from an older layout version', () => {
    // Samples are up to 15 minutes old; one from the previous layout describes
    // a different assignment entirely.
    const result = resolveBaseline(
      input({ metrics: metrics({ layout_version: 6 }) })
    );
    expect(result).toMatchObject({
      source: 'simulated',
      rejected: 'stale-layout-version',
    });
  });

  it('rejects samples taken while Garage could not report the layout', () => {
    // Without the gate, `stored_partitions: 0` for every node would read back
    // as "the whole ring moves".
    const result = resolveBaseline(
      input({ metrics: metrics({ layout_ok: false, stored_partitions: 0 }) })
    );
    expect(result).toMatchObject({ source: 'simulated', rejected: 'ungated' });
  });

  it('rejects counts that do not add up to the full ring', () => {
    const short = metrics();
    short.set('n3', metric({ stored_partitions: 12 }));
    expect(resolveBaseline(input({ metrics: short }))).toMatchObject({
      source: 'simulated',
      rejected: 'wrong-total',
    });
  });

  it('reports no baseline at all when even the simulation has no answer', () => {
    // Zeros here would read as "nothing moves", which is a claim, not a gap.
    const result = resolveBaseline(
      input({
        metrics: null,
        liveSimulation: { ok: false, reason: 'not-enough-nodes' } as SimResult,
      })
    );
    expect(result).toEqual({
      source: 'none',
      partitions: null,
      rejected: 'no-samples',
    });
  });
});
