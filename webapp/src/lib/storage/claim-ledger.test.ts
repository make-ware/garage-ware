import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertClaimDeltaAllowed,
  nodeUsableGb,
  type ClaimContext,
} from './claim-ledger';
import { GIBIBYTE } from './units';
import type { TypedPocketBase } from '@/lib/types';

interface FakeClaim {
  id: string;
  user: string;
  node_id: string;
  quota_gb: number;
}

interface FakeBucket {
  id: string;
  user: string;
  quota_gb: number;
}

interface FakeTransfer {
  id: string;
  from_user: string;
  to_user: string;
  quota_gb: number;
}

type FakeCollection = 'StorageClaims' | 'Buckets' | 'StorageTransfers';

const store: {
  StorageClaims: FakeClaim[];
  Buckets: FakeBucket[];
  StorageTransfers: FakeTransfer[];
} = {
  StorageClaims: [],
  Buckets: [],
  StorageTransfers: [],
};

/**
 * Evaluate the filter shapes the claim/bucket mutators actually emit:
 * `field = "value"` terms joined by `&&`. Anything else is a test bug, so it
 * throws rather than silently matching everything.
 */
function matchesFilter(
  record: Record<string, unknown>,
  filter: string | undefined
): boolean {
  if (!filter) return true;
  return filter.split('&&').every((rawTerm) => {
    const term = rawTerm.trim();
    const parsed = term.match(/^(\w+)\s*=\s*"(.*)"$/);
    if (!parsed) throw new Error(`Unsupported test filter term: ${term}`);
    return record[parsed[1]] === parsed[2];
  });
}

function fakePb(): TypedPocketBase {
  return {
    collection(name: FakeCollection) {
      return {
        getList(
          _page: number,
          _perPage: number,
          options?: { filter?: string }
        ) {
          const items = (
            store[name] as unknown as Record<string, unknown>[]
          ).filter((r) => matchesFilter(r, options?.filter));
          return Promise.resolve({
            items,
            page: 1,
            perPage: 1000,
            totalItems: items.length,
            totalPages: 1,
          });
        },
      };
    },
  } as unknown as TypedPocketBase;
}

/** A layout where `node-a` backs 3 TiB raw and `node-b` 1 TiB raw. */
function layoutCtx(replicationFactor = 3): ClaimContext {
  return {
    replicationFactor,
    layout: {
      version: 1,
      roles: [
        { id: 'node-a', zone: 'dc1', capacity: 3072 * GIBIBYTE },
        { id: 'node-b', zone: 'dc1', capacity: 1024 * GIBIBYTE },
        { id: 'node-nocap', zone: 'dc1', capacity: null },
      ],
    },
  };
}

/** node-a: 3072 GiB raw / rf 3 = 1024 GiB usable (logical). */
const NODE_A_USABLE = 1024;

beforeEach(() => {
  store.StorageClaims = [];
  store.Buckets = [];
  store.StorageTransfers = [];
});

describe('nodeUsableGb', () => {
  it('divides raw capacity by the replication factor', () => {
    expect(nodeUsableGb(layoutCtx(3), 'node-a')).toBeCloseTo(NODE_A_USABLE, 6);
  });

  it('returns null for a node missing from the layout', () => {
    expect(nodeUsableGb(layoutCtx(), 'node-gone')).toBeNull();
  });

  it('returns null for a node with no declared capacity', () => {
    expect(nodeUsableGb(layoutCtx(), 'node-nocap')).toBeNull();
  });
});

describe('assertClaimDeltaAllowed', () => {
  it('allows a positive entry that fits in the node’s free capacity', async () => {
    store.StorageClaims = [
      { id: 'c1', user: 'u1', node_id: 'node-a', quota_gb: 600 },
    ];
    await expect(
      assertClaimDeltaAllowed(fakePb(), layoutCtx(), {
        userId: 'u1',
        nodeId: 'node-a',
        deltaGb: 400,
      })
    ).resolves.toBeUndefined();
  });

  it('rejects a positive entry that overruns the node’s usable capacity', async () => {
    // 600 + 424 fills node-a's 1024 GB usable exactly, so one more GB overruns.
    store.StorageClaims = [
      { id: 'c1', user: 'u1', node_id: 'node-a', quota_gb: 600 },
      { id: 'c2', user: 'u2', node_id: 'node-a', quota_gb: 424 },
    ];
    await expect(
      assertClaimDeltaAllowed(fakePb(), layoutCtx(), {
        userId: 'u1',
        nodeId: 'node-a',
        deltaGb: 1,
      })
    ).rejects.toThrow(/exceeds node usable capacity/);
  });

  it('sums existing entries so an append grows the effective claim', async () => {
    // Ledger: +900 then -400 → effective 500. Another +524 exactly fills the node.
    store.StorageClaims = [
      { id: 'c1', user: 'u1', node_id: 'node-a', quota_gb: 900 },
      { id: 'c2', user: 'u1', node_id: 'node-a', quota_gb: -400 },
    ];
    const pb = fakePb();
    await expect(
      assertClaimDeltaAllowed(pb, layoutCtx(), {
        userId: 'u1',
        nodeId: 'node-a',
        deltaGb: NODE_A_USABLE - 500,
      })
    ).resolves.toBeUndefined();
    await expect(
      assertClaimDeltaAllowed(pb, layoutCtx(), {
        userId: 'u1',
        nodeId: 'node-a',
        deltaGb: NODE_A_USABLE - 500 + 1,
      })
    ).rejects.toThrow(/exceeds node usable capacity/);
  });

  it('allows a negative entry that reclaims within the existing claim', async () => {
    store.StorageClaims = [
      { id: 'c1', user: 'u1', node_id: 'node-a', quota_gb: 800 },
    ];
    await expect(
      assertClaimDeltaAllowed(fakePb(), layoutCtx(), {
        userId: 'u1',
        nodeId: 'node-a',
        deltaGb: -800,
      })
    ).resolves.toBeUndefined();
  });

  it('rejects a negative entry that drives the user’s claim on the node below zero', async () => {
    store.StorageClaims = [
      { id: 'c1', user: 'u1', node_id: 'node-a', quota_gb: 800 },
      // Another user's headroom on the same node must not absorb u1's overdraft.
      { id: 'c2', user: 'u2', node_id: 'node-a', quota_gb: 200 },
    ];
    await expect(
      assertClaimDeltaAllowed(fakePb(), layoutCtx(), {
        userId: 'u1',
        nodeId: 'node-a',
        deltaGb: -801,
      })
    ).rejects.toThrow(/negative/);
  });

  it('rejects a reclaim that would strand already-allocated buckets', async () => {
    store.StorageClaims = [
      { id: 'c1', user: 'u1', node_id: 'node-a', quota_gb: 800 },
    ];
    store.Buckets = [{ id: 'b1', user: 'u1', quota_gb: 600 }];
    await expect(
      assertClaimDeltaAllowed(fakePb(), layoutCtx(), {
        userId: 'u1',
        nodeId: 'node-a',
        deltaGb: -300,
      })
    ).rejects.toThrow(/already-allocated buckets/);
  });

  it('allows a reclaim down to exactly the allocated bucket total', async () => {
    store.StorageClaims = [
      { id: 'c1', user: 'u1', node_id: 'node-a', quota_gb: 800 },
    ];
    store.Buckets = [{ id: 'b1', user: 'u1', quota_gb: 600 }];
    await expect(
      assertClaimDeltaAllowed(fakePb(), layoutCtx(), {
        userId: 'u1',
        nodeId: 'node-a',
        deltaGb: -200,
      })
    ).resolves.toBeUndefined();
  });

  it('counts claims on other nodes toward the allocated-buckets check', async () => {
    store.StorageClaims = [
      { id: 'c1', user: 'u1', node_id: 'node-a', quota_gb: 500 },
      { id: 'c2', user: 'u1', node_id: 'node-b', quota_gb: 300 },
    ];
    store.Buckets = [{ id: 'b1', user: 'u1', quota_gb: 600 }];
    // 800 granted − 300 = 500 remaining, still short of the 600 allocated.
    await expect(
      assertClaimDeltaAllowed(fakePb(), layoutCtx(), {
        userId: 'u1',
        nodeId: 'node-a',
        deltaGb: -300,
      })
    ).rejects.toThrow(/already-allocated buckets/);
  });

  it('counts storage transferred away against the reclaim headroom', async () => {
    store.StorageClaims = [
      { id: 'c1', user: 'u1', node_id: 'node-a', quota_gb: 800 },
    ];
    store.StorageTransfers = [
      { id: 't1', from_user: 'u1', to_user: 'u2', quota_gb: 300 },
    ];
    store.Buckets = [{ id: 'b1', user: 'u1', quota_gb: 400 }];
    // Net granted is 800 − 300 = 500; reclaiming 200 leaves 300 < 400 allocated.
    await expect(
      assertClaimDeltaAllowed(fakePb(), layoutCtx(), {
        userId: 'u1',
        nodeId: 'node-a',
        deltaGb: -200,
      })
    ).rejects.toThrow(/already-allocated buckets/);
  });

  it('counts storage transferred in as reclaim headroom', async () => {
    store.StorageClaims = [
      { id: 'c1', user: 'u1', node_id: 'node-a', quota_gb: 800 },
    ];
    store.StorageTransfers = [
      { id: 't1', from_user: 'u2', to_user: 'u1', quota_gb: 300 },
    ];
    store.Buckets = [{ id: 'b1', user: 'u1', quota_gb: 900 }];
    // Net granted is 800 + 300 = 1100; reclaiming 200 leaves 900, exactly covering.
    await expect(
      assertClaimDeltaAllowed(fakePb(), layoutCtx(), {
        userId: 'u1',
        nodeId: 'node-a',
        deltaGb: -200,
      })
    ).resolves.toBeUndefined();
  });

  it('refuses to grow a claim on a node absent from the layout', async () => {
    store.StorageClaims = [
      { id: 'c1', user: 'u1', node_id: 'node-gone', quota_gb: 500 },
    ];
    await expect(
      assertClaimDeltaAllowed(fakePb(), layoutCtx(), {
        userId: 'u1',
        nodeId: 'node-gone',
        deltaGb: 100,
      })
    ).rejects.toThrow(/not present in the cluster layout/);
  });

  it('lets a claim on a decommissioned node be wound down', async () => {
    store.StorageClaims = [
      { id: 'c1', user: 'u1', node_id: 'node-gone', quota_gb: 500 },
    ];
    // The bucket is covered by a live claim, so retiring the phantom one is safe.
    store.Buckets = [{ id: 'b1', user: 'u1', quota_gb: 100 }];
    store.StorageClaims.push({
      id: 'c2',
      user: 'u1',
      node_id: 'node-a',
      quota_gb: 100,
    });
    await expect(
      assertClaimDeltaAllowed(fakePb(), layoutCtx(), {
        userId: 'u1',
        nodeId: 'node-gone',
        deltaGb: -500,
      })
    ).resolves.toBeUndefined();
  });
});
