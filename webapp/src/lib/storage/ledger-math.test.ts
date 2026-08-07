import { describe, expect, it } from 'vitest';
import {
  computeStorageSummary,
  filterPresentClaims,
  nodeUsableGbFrom,
  nodeUsableGbInLayout,
  presentNodeIdSet,
  rollUpClaimsByNode,
  rollUpClaimsByUserNode,
  sumClaimsByNode,
  sumClaimsByUserNode,
  sumTransfers,
  userNodeKey,
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
    expect(groups[0].nodeHostname).toBe('box1');
    expect(groups[0].nodeZone).toBe('dc1');
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
    // ...but the raw rows are still returned for display.
    expect(summary.claims).toHaveLength(2);
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
