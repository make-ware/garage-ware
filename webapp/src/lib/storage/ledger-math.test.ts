import { describe, expect, it } from 'vitest';
import {
  computeStorageSummary,
  computeSummaryFromBalances,
  filterPresentClaims,
  nodePositionsFromBalances,
  nodeUsableGbFrom,
  nodeUsableGbInLayout,
  presentNodeIdSet,
  rollUpClaimsByNode,
  rollUpClaimsByUserNode,
  sumClaimsByNode,
  sumClaimsByUserNode,
  sumTransfers,
  userNodeKey,
  type NodeBalanceLike,
  positionsForAuditTrail,
} from './ledger-math';
import { GIBIBYTE } from './units';
import type { ClusterLayout } from '@/lib/garage';
import type { StorageClaim, StorageTransfer } from '@garage-ware/shared';

/** node-a backs 3 TiB raw, node-b 1 TiB, node-nocap declares nothing. */
function layout(): ClusterLayout {
  return {
    version: 1,
    roles: [
      { id: 'node-a', zone: 'dc1', capacity: 3072 * GIBIBYTE },
      { id: 'node-b', zone: 'dc2', capacity: 1024 * GIBIBYTE },
      { id: 'node-nocap', zone: 'dc1', capacity: null },
    ],
  };
}

let seq = 0;
function claim(
  user: string,
  nodeId: string,
  quotaGb: number,
  extra: Partial<StorageClaim> = {}
): StorageClaim {
  seq += 1;
  return {
    id: `claim-${seq}`,
    user,
    node_id: nodeId,
    quota_gb: quotaGb,
    // Ascending so ordering assertions are meaningful without hand-writing dates.
    created: `2026-01-${String(seq).padStart(2, '0')} 00:00:00.000Z`,
    updated: `2026-01-${String(seq).padStart(2, '0')} 00:00:00.000Z`,
    collectionId: 'c',
    collectionName: 'StorageClaims',
    expand: {},
    ...extra,
  } as StorageClaim;
}

function transfer(from: string, to: string, quotaGb: number): StorageTransfer {
  seq += 1;
  return {
    id: `transfer-${seq}`,
    from_user: from,
    to_user: to,
    quota_gb: quotaGb,
    created: '2026-01-01 00:00:00.000Z',
    updated: '2026-01-01 00:00:00.000Z',
    collectionId: 'c',
    collectionName: 'StorageTransfers',
    expand: {},
  } as StorageTransfer;
}

describe('nodeUsableGbFrom', () => {
  it('divides raw capacity by the replication factor', () => {
    expect(nodeUsableGbFrom(3072 * GIBIBYTE, 3)).toBeCloseTo(1024, 6);
  });

  it('treats a replication factor below 1 as 1 rather than dividing by zero', () => {
    expect(nodeUsableGbFrom(1024 * GIBIBYTE, 0)).toBeCloseTo(1024, 6);
  });

  it('returns null when the node declares no capacity', () => {
    expect(nodeUsableGbFrom(null, 3)).toBeNull();
    expect(nodeUsableGbFrom(undefined, 3)).toBeNull();
    expect(nodeUsableGbFrom(0, 3)).toBeNull();
  });
});

describe('nodeUsableGbInLayout', () => {
  it('resolves a node by id', () => {
    expect(nodeUsableGbInLayout(layout(), 'node-b', 2)).toBeCloseTo(512, 6);
  });

  it('returns null for a node absent from the layout', () => {
    expect(nodeUsableGbInLayout(layout(), 'node-gone', 3)).toBeNull();
  });

  it('returns null when there is no layout at all', () => {
    expect(nodeUsableGbInLayout(null, 'node-a', 3)).toBeNull();
  });
});

describe('filterPresentClaims', () => {
  it('drops claims on nodes that have left the layout', () => {
    const claims = [claim('u1', 'node-a', 100), claim('u1', 'node-gone', 500)];
    expect(filterPresentClaims(claims, layout()).map((c) => c.node_id)).toEqual(
      ['node-a']
    );
  });

  it('keeps a node that is in the layout but declares no capacity', () => {
    // Presence and capacity are separate questions: a zero-capacity node is
    // still in the layout, and its claims still count toward the user's total.
    const claims = [claim('u1', 'node-nocap', 10)];
    expect(filterPresentClaims(claims, layout())).toHaveLength(1);
  });

  it('filters nothing when no layout is supplied', () => {
    const claims = [claim('u1', 'node-gone', 5)];
    expect(filterPresentClaims(claims)).toHaveLength(1);
  });
});

describe('presentNodeIdSet', () => {
  it('collects every role id', () => {
    expect([...presentNodeIdSet(layout())].sort()).toEqual([
      'node-a',
      'node-b',
      'node-nocap',
    ]);
  });
});

describe('sumTransfers', () => {
  it('tolerates missing amounts', () => {
    const rows = [
      transfer('a', 'b', 10),
      { ...transfer('a', 'b', 0), quota_gb: undefined },
    ] as StorageTransfer[];
    expect(sumTransfers(rows)).toBe(10);
  });
});

describe('rollUpClaimsByUserNode', () => {
  it('sums signed entries per (user, node) pair', () => {
    const groups = rollUpClaimsByUserNode([
      claim('u1', 'node-a', 100),
      claim('u1', 'node-a', -30),
      claim('u1', 'node-b', 50),
      claim('u2', 'node-a', 10),
    ]);
    const byKey = new Map(groups.map((g) => [g.key, g.claimedGb]));
    expect(byKey.get(userNodeKey('u1', 'node-a'))).toBe(70);
    expect(byKey.get(userNodeKey('u1', 'node-b'))).toBe(50);
    expect(byKey.get(userNodeKey('u2', 'node-a'))).toBe(10);
  });

  it('keeps a pair whose entries net to zero, so it can still be seen and wound down', () => {
    const groups = rollUpClaimsByUserNode([
      claim('u1', 'node-a', 100),
      claim('u1', 'node-a', -100),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].claimedGb).toBe(0);
    expect(groups[0].entries).toHaveLength(2);
  });

  it('orders each pair’s entries newest first', () => {
    const older = claim('u1', 'node-a', 10);
    const newer = claim('u1', 'node-a', 20);
    const groups = rollUpClaimsByUserNode([older, newer]);
    expect(groups[0].entries.map((e) => e.id)).toEqual([newer.id, older.id]);
  });

  it('flags pairs on nodes missing from the layout', () => {
    const groups = rollUpClaimsByUserNode(
      [claim('u1', 'node-a', 10), claim('u1', 'node-gone', 10)],
      layout()
    );
    const byNode = new Map(groups.map((g) => [g.nodeId, g.presentInLayout]));
    expect(byNode.get('node-a')).toBe(true);
    expect(byNode.get('node-gone')).toBe(false);
  });

  it('treats every node as present when no layout is supplied', () => {
    const groups = rollUpClaimsByUserNode([claim('u1', 'node-gone', 10)]);
    expect(groups[0].presentInLayout).toBe(true);
  });

  it('carries node metadata from whichever entry has it', () => {
    const groups = rollUpClaimsByUserNode([
      claim('u1', 'node-a', 10),
      claim('u1', 'node-a', 5, { node_hostname: 'box1', node_zone: 'dc1' }),
    ]);
    expect(groups[0].nodeZone).toBe('dc1');
    // No hostname is projected: a node is identified by its name or short id,
    // resolved from the live layout rather than this write-time snapshot.
    expect('nodeHostname' in groups[0]).toBe(false);
  });
});

describe('rollUpClaimsByNode', () => {
  it('drops nodes whose entries net to zero by default', () => {
    const groups = rollUpClaimsByNode([
      claim('u1', 'node-a', 100),
      claim('u1', 'node-a', -100),
      claim('u1', 'node-b', 25),
    ]);
    expect(groups.map((g) => g.nodeId)).toEqual(['node-b']);
  });

  it('keeps zeroed nodes when asked', () => {
    const groups = rollUpClaimsByNode(
      [claim('u1', 'node-a', 100), claim('u1', 'node-a', -100)],
      undefined,
      { includeZero: true }
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].claimedGb).toBe(0);
  });
});

describe('sumClaimsByNode / sumClaimsByUserNode', () => {
  it('sums a node across all users', () => {
    const totals = sumClaimsByNode([
      claim('u1', 'node-a', 100),
      claim('u2', 'node-a', 50),
      claim('u1', 'node-b', 10),
    ]);
    expect(totals.get('node-a')).toBe(150);
    expect(totals.get('node-b')).toBe(10);
  });

  it('keys per-user-per-node totals the same way the roll-up does', () => {
    const totals = sumClaimsByUserNode([
      claim('u1', 'node-a', 100),
      claim('u2', 'node-a', 50),
    ]);
    expect(totals.get(userNodeKey('u1', 'node-a'))).toBe(100);
    expect(totals.get(userNodeKey('u2', 'node-a'))).toBe(50);
  });
});

describe('computeStorageSummary', () => {
  it('nets claims plus received minus sent', () => {
    const summary = computeStorageSummary(
      [claim('u1', 'node-a', 100)],
      [transfer('u1', 'u2', 30)],
      [transfer('u3', 'u1', 10)],
      0,
      layout()
    );
    expect(summary.claimsGb).toBe(100);
    expect(summary.sentGb).toBe(30);
    expect(summary.receivedGb).toBe(10);
    expect(summary.netGrantedGb).toBe(80);
  });

  it('excludes claims on nodes that have left the layout', () => {
    const summary = computeStorageSummary(
      [claim('u1', 'node-a', 100), claim('u1', 'node-gone', 500)],
      [],
      [],
      0,
      layout()
    );
    // The retired node's 500 GB backs nothing, so it must not inflate the grant.
    expect(summary.claimsGb).toBe(100);
    expect(summary.netGrantedGb).toBe(100);
    // ...but the node is still listed, flagged, so the UI can show why.
    expect(summary.nodeClaims).toHaveLength(2);
    expect(
      summary.nodeClaims.find((n) => n.nodeId === 'node-gone')?.presentInLayout
    ).toBe(false);
  });

  it('never filters transfers by layout, since they are node-agnostic', () => {
    const summary = computeStorageSummary(
      [],
      [],
      [transfer('u2', 'u1', 42)],
      0,
      layout()
    );
    expect(summary.netGrantedGb).toBe(42);
  });

  it('subtracts allocated buckets to get available', () => {
    const summary = computeStorageSummary(
      [claim('u1', 'node-a', 100)],
      [],
      [],
      40,
      layout()
    );
    expect(summary.allocatedGb).toBe(40);
    expect(summary.availableGb).toBe(60);
  });

  it('floors available at zero when a user is over-allocated', () => {
    // Reachable after a claim is reclaimed out from under existing buckets;
    // a negative "available" would render as nonsense in the UI.
    const summary = computeStorageSummary(
      [claim('u1', 'node-a', 10)],
      [],
      [],
      100,
      layout()
    );
    expect(summary.netGrantedGb).toBe(10);
    expect(summary.availableGb).toBe(0);
  });

  it('handles a user with nothing at all', () => {
    const summary = computeStorageSummary([], [], [], 0, layout());
    expect(summary).toMatchObject({
      claimsGb: 0,
      sentGb: 0,
      receivedGb: 0,
      netGrantedGb: 0,
      allocatedGb: 0,
      availableGb: 0,
    });
  });

  it('nets signed claim entries before applying the layout filter', () => {
    const summary = computeStorageSummary(
      [claim('u1', 'node-a', 100), claim('u1', 'node-a', -25)],
      [],
      [],
      0,
      layout()
    );
    expect(summary.claimsGb).toBe(75);
  });
});

/**
 * Derive balance rows from a ledger the way the PocketBase hooks in
 * pb_hooks/lib/storage-balance.js do, so the two paths can be compared.
 */
function materialize(
  claims: StorageClaim[],
  sent: StorageTransfer[],
  received: StorageTransfer[],
  allocatedGb: number
) {
  const nodes = new Map<string, NodeBalanceLike>();
  for (const c of claims) {
    let row = nodes.get(c.node_id);
    if (!row) {
      row = {
        node_id: c.node_id,
        claimed_gb: 0,
        entry_count: 0,
        node_hostname: c.node_hostname,
        node_zone: c.node_zone,
      };
      nodes.set(c.node_id, row);
    }
    row.claimed_gb += Number(c.quota_gb) || 0;
    row.entry_count = (row.entry_count ?? 0) + 1;
  }
  return {
    nodeBalances: [...nodes.values()],
    userBalance: {
      sent_gb: sumTransfers(sent),
      received_gb: sumTransfers(received),
      allocated_gb: allocatedGb,
    },
  };
}

/** Assert the cache and the ledger produce the same position. */
function expectEquivalent(
  claims: StorageClaim[],
  sent: StorageTransfer[],
  received: StorageTransfer[],
  allocatedGb: number
) {
  const raw = computeStorageSummary(
    claims,
    sent,
    received,
    allocatedGb,
    layout()
  );
  const { nodeBalances, userBalance } = materialize(
    claims,
    sent,
    received,
    allocatedGb
  );
  const cached = computeSummaryFromBalances(
    nodeBalances,
    userBalance,
    layout()
  );

  expect(cached.claimsGb).toBeCloseTo(raw.claimsGb, 9);
  expect(cached.sentGb).toBeCloseTo(raw.sentGb, 9);
  expect(cached.receivedGb).toBeCloseTo(raw.receivedGb, 9);
  expect(cached.netGrantedGb).toBeCloseTo(raw.netGrantedGb, 9);
  expect(cached.allocatedGb).toBeCloseTo(raw.allocatedGb, 9);
  expect(cached.availableGb).toBeCloseTo(raw.availableGb, 9);
  return { raw, cached };
}

describe('computeSummaryFromBalances', () => {
  // This is the property the entire materialization rests on: if reading the
  // cache can ever disagree with summing the ledger, the cache is a liability.
  it('equals computeStorageSummary for a plain position', () => {
    expectEquivalent([claim('u1', 'node-a', 100)], [], [], 0);
  });

  it('equals computeStorageSummary with transfers both ways', () => {
    expectEquivalent(
      [claim('u1', 'node-a', 100)],
      [transfer('u1', 'u2', 30)],
      [transfer('u3', 'u1', 12)],
      25
    );
  });

  it('equals computeStorageSummary with several signed entries on one node', () => {
    expectEquivalent(
      [
        claim('u1', 'node-a', 100),
        claim('u1', 'node-a', -30),
        claim('u1', 'node-a', 5),
        claim('u1', 'node-b', 40),
      ],
      [],
      [],
      0
    );
  });

  it('equals computeStorageSummary when a node has left the layout', () => {
    const { cached } = expectEquivalent(
      [claim('u1', 'node-a', 100), claim('u1', 'node-gone', 500)],
      [],
      [],
      0
    );
    // ...and both agree the retired node contributes nothing.
    expect(cached.netGrantedGb).toBe(100);
  });

  it('equals computeStorageSummary when a pair nets to zero', () => {
    expectEquivalent(
      [claim('u1', 'node-a', 100), claim('u1', 'node-a', -100)],
      [],
      [],
      0
    );
  });

  it('equals computeStorageSummary when over-allocated', () => {
    const { cached } = expectEquivalent(
      [claim('u1', 'node-a', 10)],
      [],
      [],
      90
    );
    expect(cached.availableGb).toBe(0);
  });

  it('treats a missing user balance row as a zeroed position', () => {
    const summary = computeSummaryFromBalances(
      [{ node_id: 'node-a', claimed_gb: 50 }],
      null,
      layout()
    );
    expect(summary.netGrantedGb).toBe(50);
    expect(summary.sentGb).toBe(0);
    expect(summary.receivedGb).toBe(0);
    expect(summary.allocatedGb).toBe(0);
  });

  it('flags a balance row whose node has left the layout', () => {
    const summary = computeSummaryFromBalances(
      [
        { node_id: 'node-a', claimed_gb: 10 },
        { node_id: 'node-gone', claimed_gb: 999 },
      ],
      null,
      layout()
    );
    expect(summary.netGrantedGb).toBe(10);
    const gone = summary.nodeClaims.find((n) => n.nodeId === 'node-gone');
    expect(gone?.presentInLayout).toBe(false);
    // Still listed, so the UI can explain why it does not count.
    expect(gone?.claimedGb).toBe(999);
  });

  it('counts every node when no layout is supplied', () => {
    const summary = computeSummaryFromBalances(
      [
        { node_id: 'node-a', claimed_gb: 10 },
        { node_id: 'node-gone', claimed_gb: 5 },
      ],
      null
    );
    expect(summary.netGrantedGb).toBe(15);
  });
});

describe('nodePositionsFromBalances', () => {
  it('carries hostname, zone and entry count through', () => {
    const [position] = nodePositionsFromBalances(
      [
        {
          node_id: 'node-a',
          claimed_gb: 12,
          entry_count: 3,
          node_hostname: 'box1',
          node_zone: 'dc1',
        },
      ],
      layout()
    );
    expect(position).toMatchObject({
      nodeId: 'node-a',
      nodeZone: 'dc1',
      claimedGb: 12,
      entryCount: 3,
      presentInLayout: true,
    });
    // The row carries a hostname; the position deliberately does not.
    expect('nodeHostname' in position).toBe(false);
  });

  it('normalises empty metadata strings to undefined', () => {
    // PocketBase returns "" for an unset text field, which would otherwise
    // render as a blank cell instead of falling back to the node id.
    const [position] = nodePositionsFromBalances([
      { node_id: 'node-a', claimed_gb: 1, node_hostname: '', node_zone: '' },
    ]);
    expect(position.nodeZone).toBeUndefined();
  });
});

describe('positionsForAuditTrail', () => {
  // The bug this exists for: a +4 TB grant appended to an existing 36 TB claim
  // rendered as "0 B → 4 TB", because previous_gb/new_gb describe the entry,
  // not the position. Sizes here are in the ledger's GB, so 36 TB is 36000.
  const trail = [
    { id: 'a2', delta_gb: 4000 },
    { id: 'a1', delta_gb: 36000 },
  ];

  it('reads each row against the running per-node total', () => {
    const positions = positionsForAuditTrail(trail, 40000);
    expect(positions.get('a2')).toEqual({ beforeGb: 36000, afterGb: 40000 });
    expect(positions.get('a1')).toEqual({ beforeGb: 0, afterGb: 36000 });
  });

  it('anchors on the present, so a truncated trail stays right at the top', () => {
    // Same pair, but the page only reached back as far as the newest row.
    const positions = positionsForAuditTrail([trail[0]], 40000);
    expect(positions.get('a2')).toEqual({ beforeGb: 36000, afterGb: 40000 });
    expect(positions.size).toBe(1);
  });

  it('walks negative adjustments and deletes back the same way', () => {
    const positions = positionsForAuditTrail(
      [
        { id: 'd1', delta_gb: -2000 },
        { id: 'c1', delta_gb: 5000 },
        { id: 'b1', delta_gb: 10000 },
      ],
      13000
    );
    expect(positions.get('d1')).toEqual({ beforeGb: 15000, afterGb: 13000 });
    expect(positions.get('c1')).toEqual({ beforeGb: 10000, afterGb: 15000 });
    expect(positions.get('b1')).toEqual({ beforeGb: 0, afterGb: 10000 });
  });

  it('every row before → after equals its own delta', () => {
    const rows = [
      { id: 'x3', delta_gb: 0.001 },
      { id: 'x2', delta_gb: -0.002 },
      { id: 'x1', delta_gb: 0.003 },
    ];
    const positions = positionsForAuditTrail(rows, 0.002);
    for (const row of rows) {
      const position = positions.get(row.id)!;
      // The running subtraction must not accumulate float noise — an audit row
      // reading 1.9999999999999998 GB is a bug report waiting to happen.
      expect(position.afterGb - position.beforeGb).toBeCloseTo(
        row.delta_gb,
        10
      );
      expect(String(position.beforeGb)).not.toMatch(/\d{12}/);
    }
    expect(positions.get('x1')!.beforeGb).toBe(0);
  });

  it('treats a missing delta as no movement rather than NaN', () => {
    const positions = positionsForAuditTrail(
      [{ id: 'n1' }, { id: 'm1', delta_gb: 100 }],
      100
    );
    expect(positions.get('n1')).toEqual({ beforeGb: 100, afterGb: 100 });
    expect(positions.get('m1')).toEqual({ beforeGb: 0, afterGb: 100 });
  });

  it('returns an empty map for an empty trail', () => {
    expect(positionsForAuditTrail([], 40000).size).toBe(0);
  });
});
