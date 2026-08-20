import { describe, expect, it } from 'vitest';
import {
  isPartitionSizeFeasible,
  PARTITION_COUNT,
  simulateLayout,
  ZONE_OVER_DECLARED_RATIO,
  type SimInput,
  type SimNodeInput,
  type SimResult,
  type SimSuccess,
} from './layout-sim';

const MB = 1_000_000;
const GB = 1_000_000_000;
const TB = 1_000_000_000_000;
const PB = 1_000_000_000_000_000;

const MAXIMUM = { mode: 'maximum' } as const;
const atLeast = (n: number) => ({ mode: 'atLeast', atLeast: n }) as const;

/** A storage node. `null` capacity is spelled out at the call site instead. */
function node(id: string, zone: string, capacityBytes: number): SimNodeInput {
  return { id, zone, capacityBytes };
}

function gateway(id: string, zone: string): SimNodeInput {
  return { id, zone, capacityBytes: null };
}

/** Narrow to the success branch, failing with the reason rather than `undefined`. */
function ok(result: SimResult): SimSuccess {
  if (!result.ok) {
    throw new Error(`expected a feasible layout, got ${result.reason}`);
  }
  return result;
}

/** Partition counts by node id — the shape `SimInput.previous` takes. */
function counts(result: SimSuccess): Record<string, number> {
  return Object.fromEntries(
    result.estimated.nodes.map((n) => [n.id, n.estimatedPartitions])
  );
}

function partitionsOf(result: SimSuccess, id: string): number {
  const found = result.estimated.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id} in result`);
  return found.estimatedPartitions;
}

// ── The two documented examples ─────────────────────────────────────────────
//
// https://garagehq.deuxfleurs.fr/documentation/operations/layout/
//
// These are the reason the module exists: they are the cases where Garage's
// answer surprises the operator, and any reimplementation that gets them wrong
// is worse than no planner at all.

describe('simulateLayout — Garage documentation Example 1', () => {
  const threeZones: SimInput = {
    nodes: [
      node('node1', 'dc1', 1000 * MB),
      node('node2', 'dc2', 1000 * MB),
      node('node3', 'dc3', 1000 * MB),
    ],
    replicationFactor: 3,
    zoneRedundancy: MAXIMUM,
  };

  it('gives three equal nodes in three zones the whole ring each', () => {
    const result = ok(simulateLayout(threeZones));
    // 1000 MB / 256 partitions, exactly — this figure is reproducible, and the
    // planner checks it against the operator's own cluster on every load.
    expect(result.exact.partitionSizeBytes).toBe(3_906_250);
    expect(result.exact.effectiveCapacityBytes).toBe(1000 * MB);
    expect(result.exact.totalUsableBytes).toBe(3000 * MB);
    expect(result.exact.effectiveZoneRedundancy).toBe(3);
    for (const n of result.estimated.nodes) {
      expect(n.estimatedPartitions).toBe(PARTITION_COUNT);
      expect(n.estimatedUsablePct).toBe(100);
    }
    expect(result.warnings).toEqual([]);
  });

  it('gives a fourth equal node added to dc1 exactly zero partitions', () => {
    // The documented surprise. dc2 and dc3 still cap the total at 256
    // partitions each, so nothing is gained by moving data into dc1's new
    // node — and Garage will not pay data movement for no capacity gain.
    const previous = counts(ok(simulateLayout(threeZones)));
    const result = ok(
      simulateLayout({
        ...threeZones,
        nodes: [...threeZones.nodes, node('node4', 'dc1', 1000 * MB)],
        previous,
      })
    );

    expect(result.exact.partitionSizeBytes).toBe(3_906_250);
    expect(result.exact.effectiveCapacityBytes).toBe(1000 * MB);
    expect(partitionsOf(result, 'node1')).toBe(256);
    expect(partitionsOf(result, 'node2')).toBe(256);
    expect(partitionsOf(result, 'node3')).toBe(256);
    expect(partitionsOf(result, 'node4')).toBe(0);
    // 3 GB usable out of 4 GB declared, and not one byte moves.
    expect(result.exact.totalDeclaredBytes).toBe(4000 * MB);
    expect(result.estimated.partitionsMoved).toBe(0);
  });

  it('warns about the zero-partition node and names the over-declared zone', () => {
    const previous = counts(ok(simulateLayout(threeZones)));
    const result = ok(
      simulateLayout({
        ...threeZones,
        nodes: [...threeZones.nodes, node('node4', 'dc1', 1000 * MB)],
        previous,
      })
    );

    expect(result.warnings).toEqual([
      {
        kind: 'zero-partition-node',
        subject: 'node4',
        zone: 'dc1',
        declaredCapacityBytes: 1000 * MB,
        usableCapacityBytes: 0,
      },
      {
        kind: 'zone-over-declared',
        subject: 'dc1',
        zone: 'dc1',
        declaredCapacityBytes: 2000 * MB,
        usableCapacityBytes: 1000 * MB,
      },
    ]);
  });

  it('splits dc1 evenly once both its nodes declare half capacity', () => {
    // The fix the documentation gives: halving the declared capacity in the
    // oversized zone lets both nodes hold a share without changing what the
    // cluster can store.
    const previous = counts(ok(simulateLayout(threeZones)));
    const result = ok(
      simulateLayout({
        nodes: [
          node('node1', 'dc1', 500 * MB),
          node('node2', 'dc2', 1000 * MB),
          node('node3', 'dc3', 1000 * MB),
          node('node4', 'dc1', 500 * MB),
        ],
        replicationFactor: 3,
        zoneRedundancy: MAXIMUM,
        previous,
      })
    );

    expect(result.exact.partitionSizeBytes).toBe(3_906_250);
    expect(partitionsOf(result, 'node1')).toBe(128);
    expect(partitionsOf(result, 'node4')).toBe(128);
    expect(result.exact.effectiveCapacityBytes).toBe(1000 * MB);
    // Both dc1 nodes are now fully used, so nothing is over-declared.
    expect(result.warnings).toEqual([]);
  });
});

describe('simulateLayout — Garage documentation Example 2', () => {
  const fourNodes: SimNodeInput[] = [
    node('node1', 'dc1', 1000 * MB),
    node('node4', 'dc1', 1000 * MB),
    node('node2', 'dc2', 1000 * MB),
    node('node3', 'dc3', 1000 * MB),
  ];

  const before = ok(
    simulateLayout({
      nodes: fourNodes,
      replicationFactor: 3,
      zoneRedundancy: MAXIMUM,
    })
  );

  it('halves both dc1 nodes when the layout is computed from scratch', () => {
    // The documented starting point: node1 and node4 at 50% each, node2 and
    // node3 at 100%.
    expect(partitionsOf(before, 'node1')).toBe(128);
    expect(partitionsOf(before, 'node4')).toBe(128);
    expect(partitionsOf(before, 'node2')).toBe(256);
    expect(partitionsOf(before, 'node3')).toBe(256);
    expect(before.estimated.nodes.map((n) => n.estimatedUsablePct)).toEqual([
      50, 50, 100, 100,
    ]);
  });

  it('under-utilizes the node that moves dc1 → dc3 relative to the incumbent', () => {
    const after = ok(
      simulateLayout({
        nodes: [
          node('node1', 'dc1', 1000 * MB),
          node('node4', 'dc3', 1000 * MB),
          node('node2', 'dc2', 1000 * MB),
          node('node3', 'dc3', 1000 * MB),
        ],
        replicationFactor: 3,
        zoneRedundancy: MAXIMUM,
        previous: counts(before),
      })
    );

    // node1 becomes dc1's only node and takes the whole ring: 256 partitions,
    // 128 of them new. Both figures match the documentation exactly.
    expect(partitionsOf(after, 'node1')).toBe(256);
    expect(partitionsOf(after, 'node2')).toBe(256);
    expect(after.estimated.partitionsMoved).toBe(128);

    // dc3 now has two nodes sharing 256 partitions, and the incumbent keeps
    // more of them than the arrival — that direction is the documented
    // behaviour and the operator-relevant fact.
    //
    // The exact split is deliberately NOT asserted. Garage reports 193/63;
    // this module produces 171/85. Both are optimal: Garage's cost function
    // charges +1 only for a (partition, node) pair that was not previously
    // assigned, and every split with node3 ∈ [128, 256] here has cost exactly
    // 0. Asserting 193 would be asserting which optimum
    // `optimize_flow_with_cost` happens to reach.
    const node3 = partitionsOf(after, 'node3');
    const node4 = partitionsOf(after, 'node4');
    expect(node3 + node4).toBe(PARTITION_COUNT);
    expect(node3).toBeGreaterThanOrEqual(node4);
    expect(node3).toBeGreaterThanOrEqual(128);
    expect(node3).toBeLessThanOrEqual(256);
  });
});

// ── Degenerate input ────────────────────────────────────────────────────────

describe('simulateLayout — inputs with no answer', () => {
  /** An infeasible result must carry no capacity figure an operator could copy. */
  function expectNoNumbers(result: SimResult) {
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('exact');
    expect(result).not.toHaveProperty('estimated');
    expect(result).not.toHaveProperty('warnings');
  }

  it('refuses a cluster with fewer storage nodes than the replication factor', () => {
    const result = simulateLayout({
      nodes: [node('a', 'dc1', 1 * TB), node('b', 'dc2', 1 * TB)],
      replicationFactor: 3,
      zoneRedundancy: MAXIMUM,
    });
    expect(result).toMatchObject({ ok: false, reason: 'not-enough-nodes' });
    expectNoNumbers(result);
  });

  it('counts gateways as no help at all', () => {
    const result = simulateLayout({
      nodes: [
        node('a', 'dc1', 1 * TB),
        node('b', 'dc2', 1 * TB),
        gateway('g', 'dc3'),
      ],
      replicationFactor: 3,
      zoneRedundancy: MAXIMUM,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'not-enough-nodes',
      detail: { storageNodeCount: 2, storageZoneCount: 2 },
    });
  });

  it('refuses fewer zones than an explicit zone redundancy demands', () => {
    const result = simulateLayout({
      nodes: [
        node('a', 'dc1', 1 * TB),
        node('b', 'dc1', 1 * TB),
        node('c', 'dc2', 1 * TB),
      ],
      replicationFactor: 3,
      zoneRedundancy: atLeast(3),
    });
    expect(result).toMatchObject({ ok: false, reason: 'not-enough-zones' });
    expectNoNumbers(result);
  });

  it('refuses a zone redundancy above the replication factor', () => {
    // `rf − k` is the capacity of the Source→Pdown edge in Garage's flow
    // graph; a negative one is not an infeasible layout, it is a nonsense one.
    const result = simulateLayout({
      nodes: [
        node('a', 'dc1', 1 * TB),
        node('b', 'dc2', 1 * TB),
        node('c', 'dc3', 1 * TB),
      ],
      replicationFactor: 2,
      zoneRedundancy: atLeast(3),
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid-redundancy' });
    expectNoNumbers(result);
  });

  it('refuses a cluster too small to hold one byte per partition', () => {
    const result = simulateLayout({
      nodes: [
        node('a', 'dc1', 100),
        node('b', 'dc2', 100),
        node('c', 'dc3', 100),
      ],
      replicationFactor: 3,
      zoneRedundancy: MAXIMUM,
    });
    expect(result).toMatchObject({ ok: false, reason: 'capacity-too-small' });
    expectNoNumbers(result);
  });

  it('refuses a total capacity past the precision of a double', () => {
    // Beyond 2^53 (≈ 9 PB) adjacent integers stop being distinguishable, so
    // every figure below would be quietly approximate. A wrong answer for a
    // real cluster size is not better than no answer.
    const result = simulateLayout({
      nodes: [
        node('a', 'dc1', 4 * PB),
        node('b', 'dc2', 4 * PB),
        node('c', 'dc3', 4 * PB),
      ],
      replicationFactor: 3,
      zoneRedundancy: MAXIMUM,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'capacity-out-of-range',
    });
    expectNoNumbers(result);
  });
});

// ── The terms that are easy to omit ─────────────────────────────────────────

describe('simulateLayout — constraints a simpler formula would miss', () => {
  it('caps each node at one replica per partition', () => {
    // One zone, `atLeast: 1`, three nodes, one of them tiny. Without the
    // per-node `min(⌊cap/P⌋, 256)` cap the two large nodes appear able to
    // supply all 768 replicas between them, and the planner reports a
    // partition size four billion times too large. With it, the tiny node is
    // required for the third replica and bounds everything.
    const result = ok(
      simulateLayout({
        nodes: [
          node('big1', 'dc1', 1 * TB),
          node('big2', 'dc1', 1 * TB),
          node('tiny', 'dc1', 1000),
        ],
        replicationFactor: 3,
        zoneRedundancy: atLeast(1),
      })
    );
    expect(result.exact.partitionSizeBytes).toBe(Math.floor(1000 / 256));
    expect(partitionsOf(result, 'tiny')).toBe(256);
  });

  it('caps a one-node zone at the ring however large its disk', () => {
    const result = ok(
      simulateLayout({
        nodes: [
          node('a', 'dc1', 100 * TB),
          node('b', 'dc2', 1 * TB),
          node('c', 'dc3', 1 * TB),
        ],
        replicationFactor: 3,
        zoneRedundancy: MAXIMUM,
      })
    );
    const dc1 = result.estimated.zones.find((z) => z.zone === 'dc1')!;
    expect(dc1.maxPartitions).toBe(PARTITION_COUNT);
    expect(dc1.estimatedPartitions).toBe(PARTITION_COUNT);
    // 100 TB declared, 1 TB usable — the over-declaration warning's whole job.
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: 'zone-over-declared', subject: 'dc1' })
    );
  });

  it('lets one zone hold rf − k + 1 replicas, not ceil(rf / zones)', () => {
    // rf 5 over 2 zones under `maximum`: k = 2, so a partition may legally put
    // four replicas in one zone and one in the other. `ceil(5 / 2) = 3` would
    // agree at rf 3 and understate here.
    const result = ok(
      simulateLayout({
        nodes: [
          node('a1', 'dc1', 10 * TB),
          node('a2', 'dc1', 10 * TB),
          node('a3', 'dc1', 10 * TB),
          node('a4', 'dc1', 10 * TB),
          node('b1', 'dc2', 10 * TB),
        ],
        replicationFactor: 5,
        zoneRedundancy: MAXIMUM,
      })
    );
    expect(result.exact.effectiveZoneRedundancy).toBe(2);
    const dc1 = result.estimated.zones.find((z) => z.zone === 'dc1')!;
    expect(dc1.replicasPerPartition).toBe(4);
    expect(dc1.estimatedPartitions).toBe(4 * PARTITION_COUNT);
  });

  it('is exact at the flooring boundary', () => {
    const exact = ok(
      simulateLayout({
        nodes: [
          node('a', 'dc1', 256 * 1000),
          node('b', 'dc2', 256 * 1000),
          node('c', 'dc3', 256 * 1000),
        ],
        replicationFactor: 3,
        zoneRedundancy: MAXIMUM,
      })
    );
    expect(exact.exact.partitionSizeBytes).toBe(1000);

    const oneByteShort = ok(
      simulateLayout({
        nodes: [
          node('a', 'dc1', 256 * 1000 - 1),
          node('b', 'dc2', 256 * 1000 - 1),
          node('c', 'dc3', 256 * 1000 - 1),
        ],
        replicationFactor: 3,
        zoneRedundancy: MAXIMUM,
      })
    );
    expect(oneByteShort.exact.partitionSizeBytes).toBe(999);
  });

  it('handles a single zone at replication factor 3', () => {
    const result = ok(
      simulateLayout({
        nodes: [
          node('a', 'dc1', 3 * TB),
          node('b', 'dc1', 3 * TB),
          node('c', 'dc1', 3 * TB),
        ],
        replicationFactor: 3,
        zoneRedundancy: MAXIMUM,
      })
    );
    // With one zone, `maximum` resolves k to 1 and every node holds the ring.
    expect(result.exact.effectiveZoneRedundancy).toBe(1);
    for (const n of result.estimated.nodes) {
      expect(n.estimatedPartitions).toBe(PARTITION_COUNT);
    }
  });

  it('handles replication factor 1', () => {
    const result = ok(
      simulateLayout({
        nodes: [node('a', 'dc1', 1 * TB), node('b', 'dc1', 3 * TB)],
        replicationFactor: 1,
        zoneRedundancy: MAXIMUM,
      })
    );
    expect(result.exact.totalUsableBytes).toBe(
      result.exact.effectiveCapacityBytes
    );
    const total = result.estimated.nodes.reduce(
      (a, n) => a + n.estimatedPartitions,
      0
    );
    expect(total).toBe(PARTITION_COUNT);
  });

  it('gives gateways nothing and does not warn about them', () => {
    const result = ok(
      simulateLayout({
        nodes: [
          node('a', 'dc1', 1 * TB),
          node('b', 'dc2', 1 * TB),
          node('c', 'dc3', 1 * TB),
          gateway('gw', 'dc1'),
        ],
        replicationFactor: 3,
        zoneRedundancy: MAXIMUM,
      })
    );
    const gw = result.estimated.nodes.find((n) => n.id === 'gw')!;
    expect(gw).toMatchObject({
      gateway: true,
      estimatedPartitions: 0,
      estimatedUsableBytes: 0,
      estimatedUsablePct: null,
    });
    expect(result.warnings).toEqual([]);
  });

  it('names the zone that alone bounds the partition size', () => {
    const result = ok(
      simulateLayout({
        nodes: [
          node('a', 'dc1', 1 * TB),
          node('b', 'dc2', 50 * TB),
          node('c', 'dc3', 50 * TB),
        ],
        replicationFactor: 3,
        zoneRedundancy: MAXIMUM,
      })
    );
    expect(
      result.estimated.zones.filter((z) => z.limiting).map((z) => z.zone)
    ).toEqual(['dc1']);
  });

  it('marks no zone limiting when every zone would have to grow', () => {
    const result = ok(
      simulateLayout({
        nodes: [
          node('a', 'dc1', 1 * TB),
          node('b', 'dc2', 1 * TB),
          node('c', 'dc3', 1 * TB),
        ],
        replicationFactor: 3,
        zoneRedundancy: MAXIMUM,
      })
    );
    expect(result.estimated.zones.every((z) => !z.limiting)).toBe(true);
  });
});

// ── The over-declaration threshold ──────────────────────────────────────────

describe('warning thresholds', () => {
  it('stays quiet on a zone within the tolerance', () => {
    // A balanced cluster wastes a little to integer partition counts; a
    // warning that fires on a healthy cluster is one operators learn to skip.
    const result = ok(
      simulateLayout({
        nodes: [
          node('a', 'dc1', 1 * TB),
          node('b', 'dc2', 1 * TB),
          node('c', 'dc3', 1 * TB),
        ],
        replicationFactor: 3,
        zoneRedundancy: MAXIMUM,
      })
    );
    for (const zone of result.estimated.zones) {
      expect(
        zone.estimatedUsableBytes / zone.declaredCapacityBytes
      ).toBeGreaterThanOrEqual(ZONE_OVER_DECLARED_RATIO);
    }
    expect(result.warnings).toEqual([]);
  });
});

// ── Invariants over generated topologies ────────────────────────────────────

/** Seeded PRNG — deterministic, dependency-free, and enough for topologies. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Topology {
  input: SimInput;
  zoneCount: number;
}

function randomTopology(random: () => number): Topology {
  const zoneCount = 1 + Math.floor(random() * 4);
  const nodeCount = 1 + Math.floor(random() * 8);
  const replicationFactor = 1 + Math.floor(random() * 3);
  const nodes: SimNodeInput[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const zone = `dc${1 + Math.floor(random() * zoneCount)}`;
    // A wide spread of magnitudes, plus the occasional gateway: the flooring
    // and per-node-cap terms only bite when capacities are lopsided.
    const gatewayRoll = random() < 0.15;
    nodes.push({
      id: `n${i}`,
      zone,
      capacityBytes: gatewayRoll
        ? null
        : Math.ceil(random() * 20) * 10 ** (9 + Math.floor(random() * 4)),
    });
  }
  const zoneRedundancy =
    random() < 0.5
      ? MAXIMUM
      : atLeast(1 + Math.floor(random() * replicationFactor));
  return {
    input: { nodes, replicationFactor, zoneRedundancy },
    zoneCount: new Set(nodes.filter((n) => n.capacityBytes).map((n) => n.zone))
      .size,
  };
}

describe('simulateLayout — invariants over 500 generated topologies', () => {
  const random = mulberry32(20260820);
  const feasible: { input: SimInput; result: SimSuccess }[] = [];
  for (let i = 0; i < 500; i++) {
    const { input } = randomTopology(random);
    const result = simulateLayout(input);
    if (result.ok) feasible.push({ input, result });
  }

  it('generated enough feasible topologies to be worth asserting on', () => {
    expect(feasible.length).toBeGreaterThan(100);
  });

  it('places exactly PARTITION_COUNT × rf replicas, every time', () => {
    for (const { input, result } of feasible) {
      const placed = result.estimated.nodes.reduce(
        (a, n) => a + n.estimatedPartitions,
        0
      );
      expect(placed).toBe(PARTITION_COUNT * input.replicationFactor);
    }
  });

  it('keeps every node within its own ceiling', () => {
    for (const { result } of feasible) {
      for (const n of result.estimated.nodes) {
        expect(Number.isInteger(n.estimatedPartitions)).toBe(true);
        expect(n.estimatedPartitions).toBeGreaterThanOrEqual(0);
        expect(n.estimatedPartitions).toBeLessThanOrEqual(n.maxPartitions);
        expect(n.maxPartitions).toBeLessThanOrEqual(PARTITION_COUNT);
        if (n.gateway) expect(n.estimatedPartitions).toBe(0);
      }
    }
  });

  it('keeps every zone within rf − k + 1 replicas per partition', () => {
    for (const { input, result } of feasible) {
      const k = result.exact.effectiveZoneRedundancy;
      const cap = input.replicationFactor - k + 1;
      for (const zone of result.estimated.zones) {
        expect(zone.replicasPerPartition).toBeLessThanOrEqual(cap);
        expect(zone.estimatedPartitions).toBeLessThanOrEqual(
          PARTITION_COUNT * zone.replicasPerPartition
        );
      }
      // When redundancy consumes every zone, each one holds the whole ring.
      if (
        k === input.replicationFactor &&
        result.estimated.zones.length === k
      ) {
        for (const zone of result.estimated.zones) {
          expect(zone.estimatedPartitions).toBe(PARTITION_COUNT);
        }
      }
    }
  });

  it('returns the LARGEST feasible partition size', () => {
    // The strongest single assertion here: `feasible(P) ∧ ¬feasible(P + 1)`
    // pins the binary search from both sides.
    for (const { input, result } of feasible) {
      const { partitionSizeBytes, effectiveZoneRedundancy } = result.exact;
      const check = (p: number) =>
        isPartitionSizeFeasible(
          input.nodes,
          input.replicationFactor,
          effectiveZoneRedundancy,
          p
        );
      expect(check(partitionSizeBytes)).toBe(true);
      expect(check(partitionSizeBytes + 1)).toBe(false);
    }
  });

  it('keeps the exact figures algebraically consistent', () => {
    for (const { input, result } of feasible) {
      const { partitionSizeBytes, effectiveCapacityBytes, totalUsableBytes } =
        result.exact;
      expect(effectiveCapacityBytes).toBe(PARTITION_COUNT * partitionSizeBytes);
      expect(totalUsableBytes).toBe(
        effectiveCapacityBytes * input.replicationFactor
      );
      const summed = result.estimated.nodes.reduce(
        (a, n) => a + n.estimatedUsableBytes,
        0
      );
      expect(summed).toBe(totalUsableBytes);
    }
  });

  it('does not depend on the order the nodes arrive in', () => {
    const shuffle = mulberry32(7);
    for (const { input, result } of feasible) {
      const reordered = [...input.nodes].sort(() => shuffle() - 0.5);
      const again = ok(simulateLayout({ ...input, nodes: reordered }));
      expect(again.exact).toEqual(result.exact);
      expect(counts(again)).toEqual(counts(result));
    }
  });

  it('is a fixed point of itself', () => {
    // Feeding a layout back in as the baseline must reproduce it and move
    // nothing — otherwise the planner would report phantom traffic every time
    // an operator opened it without changing anything.
    for (const { input, result } of feasible) {
      const again = ok(simulateLayout({ ...input, previous: counts(result) }));
      expect(counts(again)).toEqual(counts(result));
      expect(again.estimated.partitionsMoved).toBe(0);
    }
  });

  it('never shrinks the partition size when a node grows', () => {
    for (const { input, result } of feasible) {
      const target = input.nodes.findIndex((n) => n.capacityBytes !== null);
      if (target < 0) continue;
      const grown = input.nodes.map((n, i) =>
        i === target ? { ...n, capacityBytes: (n.capacityBytes ?? 0) * 2 } : n
      );
      const after = simulateLayout({ ...input, nodes: grown });
      expect(after.ok).toBe(true);
      expect(ok(after).exact.partitionSizeBytes).toBeGreaterThanOrEqual(
        result.exact.partitionSizeBytes
      );
    }
  });

  it('never shrinks the partition size when a node joins an existing zone', () => {
    for (const { input, result } of feasible) {
      const existing = input.nodes.find((n) => n.capacityBytes !== null);
      if (!existing) continue;
      const after = simulateLayout({
        ...input,
        nodes: [
          ...input.nodes,
          { id: 'extra', zone: existing.zone, capacityBytes: 1 * TB },
        ],
      });
      expect(ok(after).exact.partitionSizeBytes).toBeGreaterThanOrEqual(
        result.exact.partitionSizeBytes
      );
    }
  });
});

describe('feasibility is downward-closed in the partition size', () => {
  it('never flips back to feasible as P grows', () => {
    // Brute force, because the binary search is only correct if this holds and
    // the monotonicity argument (`P↑ ⇒ c_n↓ ⇒ m_z↓ ⇒ supply↓`) survives the
    // node-count term in `m_z`.
    const random = mulberry32(99);
    for (let t = 0; t < 40; t++) {
      const { input } = randomTopology(random);
      const zones = new Set(
        input.nodes.filter((n) => n.capacityBytes).map((n) => n.zone)
      ).size;
      if (zones === 0) continue;
      const k =
        input.zoneRedundancy.mode === 'atLeast'
          ? input.zoneRedundancy.atLeast
          : Math.min(zones, input.replicationFactor);
      if (k > input.replicationFactor) continue;
      let seenInfeasible = false;
      for (let p = 1; p <= 4000; p += 7) {
        const feasible = isPartitionSizeFeasible(
          input.nodes,
          input.replicationFactor,
          k,
          p
        );
        if (!feasible) seenInfeasible = true;
        else expect(seenInfeasible).toBe(false);
      }
    }
  });
});

// ── The max-flow oracle ─────────────────────────────────────────────────────

/**
 * Garage's actual flow graph, built literally, solved by Edmonds–Karp.
 *
 * This is what licenses the closed form the engine uses instead: if the two
 * ever disagree, the closed form is wrong and every capacity figure the
 * planner prints is wrong with it. `partitionCount` is scaled down so the
 * graph stays small — the argument for the closed form is independent of how
 * many partitions there are.
 */
function maxFlow(
  nodes: readonly SimNodeInput[],
  replicationFactor: number,
  zoneRedundancy: number,
  partitionSizeBytes: number,
  partitionCount: number
): number {
  const storage = nodes.filter(
    (n): n is SimNodeInput & { capacityBytes: number } =>
      n.capacityBytes !== null && n.capacityBytes > 0
  );
  const zones = [...new Set(storage.map((n) => n.zone))];

  const SOURCE = 0;
  const SINK = 1;
  let next = 2;
  const pUp: number[] = [];
  const pDown: number[] = [];
  const pZone: number[][] = [];
  for (let p = 0; p < partitionCount; p++) {
    pUp.push(next++);
    pDown.push(next++);
    pZone.push(zones.map(() => next++));
  }
  const nodeVertex = storage.map(() => next++);

  const capacity = Array.from({ length: next }, () =>
    new Array<number>(next).fill(0)
  );
  for (let p = 0; p < partitionCount; p++) {
    capacity[SOURCE][pUp[p]] = zoneRedundancy;
    capacity[SOURCE][pDown[p]] = replicationFactor - zoneRedundancy;
    zones.forEach((zone, z) => {
      capacity[pUp[p]][pZone[p][z]] = 1;
      capacity[pDown[p]][pZone[p][z]] = replicationFactor;
      storage.forEach((n, i) => {
        if (n.zone === zone) capacity[pZone[p][z]][nodeVertex[i]] = 1;
      });
    });
  }
  storage.forEach((n, i) => {
    capacity[nodeVertex[i]][SINK] = Math.floor(
      n.capacityBytes / partitionSizeBytes
    );
  });

  let flow = 0;
  for (;;) {
    const parent = new Array<number>(next).fill(-1);
    parent[SOURCE] = SOURCE;
    const queue = [SOURCE];
    while (queue.length > 0 && parent[SINK] === -1) {
      const u = queue.shift()!;
      for (let v = 0; v < next; v++) {
        if (parent[v] === -1 && capacity[u][v] > 0) {
          parent[v] = u;
          queue.push(v);
        }
      }
    }
    if (parent[SINK] === -1) return flow;
    let augment = Infinity;
    for (let v = SINK; v !== SOURCE; v = parent[v]) {
      augment = Math.min(augment, capacity[parent[v]][v]);
    }
    for (let v = SINK; v !== SOURCE; v = parent[v]) {
      capacity[parent[v]][v] -= augment;
      capacity[v][parent[v]] += augment;
    }
    flow += augment;
  }
}

describe('the closed form equals the max-flow it replaces', () => {
  it('agrees with Ford–Fulkerson on every small topology', () => {
    const random = mulberry32(4242);
    const partitionCount = 6;
    let checked = 0;
    let bothWays = { feasible: 0, infeasible: 0 };

    for (let t = 0; t < 250; t++) {
      const zoneCount = 1 + Math.floor(random() * 3);
      const nodeCount = 1 + Math.floor(random() * 5);
      const replicationFactor = 1 + Math.floor(random() * 3);
      const nodes: SimNodeInput[] = [];
      for (let i = 0; i < nodeCount; i++) {
        nodes.push({
          id: `n${i}`,
          zone: `z${1 + Math.floor(random() * zoneCount)}`,
          capacityBytes: random() < 0.1 ? null : 1 + Math.floor(random() * 40),
        });
      }
      const zones = new Set(
        nodes.filter((n) => n.capacityBytes).map((n) => n.zone)
      ).size;
      if (zones === 0) continue;
      const k =
        random() < 0.5
          ? Math.min(zones, replicationFactor)
          : 1 + Math.floor(random() * replicationFactor);
      if (k > replicationFactor) continue;

      for (const p of [1, 2, 3, 5, 9]) {
        const expected =
          maxFlow(nodes, replicationFactor, k, p, partitionCount) ===
          partitionCount * replicationFactor;
        const actual = isPartitionSizeFeasible(
          nodes,
          replicationFactor,
          k,
          p,
          partitionCount
        );
        expect(actual).toBe(expected);
        checked++;
        if (expected) bothWays.feasible++;
        else bothWays.infeasible++;
      }
    }

    // Guard against a run that only ever exercised one branch and passed for
    // the wrong reason.
    expect(checked).toBeGreaterThan(500);
    expect(bothWays.feasible).toBeGreaterThan(20);
    expect(bothWays.infeasible).toBeGreaterThan(20);
  });
});
