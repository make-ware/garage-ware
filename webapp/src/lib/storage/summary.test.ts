import { beforeEach, describe, expect, it } from 'vitest';
import { getStorageSummariesForUsers, getUserStorageSummary } from './summary';
import { GIBIBYTE } from './units';
import type { ClusterLayout } from '@/lib/garage';
import type { TypedPocketBase } from '@/lib/types';

interface FakeClaim {
  id: string;
  user: string;
  node_id: string;
  quota_gb: number;
  created: string;
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
  created: string;
}

type FakeCollection = 'StorageClaims' | 'Buckets' | 'StorageTransfers';

const store: {
  StorageClaims: FakeClaim[];
  Buckets: FakeBucket[];
  StorageTransfers: FakeTransfer[];
} = { StorageClaims: [], Buckets: [], StorageTransfers: [] };

/** Counts list calls so the N+1 claim can actually be asserted. */
let listCalls = 0;

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

/** A PocketBase stand-in that paginates for real, so paging bugs surface. */
function fakePb(): TypedPocketBase {
  return {
    collection(name: FakeCollection) {
      return {
        getList(page: number, perPage: number, options?: { filter?: string }) {
          listCalls += 1;
          const all = (
            store[name] as unknown as Record<string, unknown>[]
          ).filter((r) => matchesFilter(r, options?.filter));
          const start = (page - 1) * perPage;
          const items = all.slice(start, start + perPage);
          return Promise.resolve({
            items,
            page,
            perPage,
            totalItems: all.length,
            totalPages: Math.max(Math.ceil(all.length / perPage), 1),
          });
        },
      };
    },
  } as unknown as TypedPocketBase;
}

function layout(): ClusterLayout {
  return {
    version: 1,
    roles: [
      { id: 'node-a', zone: 'dc1', capacity: 3072 * GIBIBYTE },
      { id: 'node-b', zone: 'dc2', capacity: 1024 * GIBIBYTE },
    ],
  };
}

let seq = 0;
function addClaim(user: string, nodeId: string, quotaGb: number) {
  seq += 1;
  store.StorageClaims.push({
    id: `c${seq}`,
    user,
    node_id: nodeId,
    quota_gb: quotaGb,
    created: `2026-01-01 00:00:${String(seq).padStart(2, '0')}.000Z`,
  });
}
function addTransfer(from: string, to: string, quotaGb: number) {
  seq += 1;
  store.StorageTransfers.push({
    id: `t${seq}`,
    from_user: from,
    to_user: to,
    quota_gb: quotaGb,
    created: `2026-01-01 00:00:${String(seq).padStart(2, '0')}.000Z`,
  });
}
function addBucket(user: string, quotaGb: number) {
  seq += 1;
  store.Buckets.push({ id: `b${seq}`, user, quota_gb: quotaGb });
}

beforeEach(() => {
  store.StorageClaims = [];
  store.Buckets = [];
  store.StorageTransfers = [];
  listCalls = 0;
  seq = 0;
});

describe('getStorageSummariesForUsers', () => {
  it('agrees with getUserStorageSummary for every user', async () => {
    addClaim('u1', 'node-a', 100);
    addClaim('u1', 'node-a', -20);
    addClaim('u2', 'node-b', 50);
    addTransfer('u1', 'u2', 30);
    addTransfer('u3', 'u1', 5);
    addBucket('u1', 25);
    addBucket('u2', 60);

    const pb = fakePb();
    const bulk = await getStorageSummariesForUsers(
      pb,
      ['u1', 'u2', 'u3'],
      layout()
    );

    for (const userId of ['u1', 'u2', 'u3']) {
      const single = await getUserStorageSummary(pb, userId, layout());
      const fromBulk = bulk.get(userId)!;
      expect(fromBulk.claimsGb, userId).toBe(single.claimsGb);
      expect(fromBulk.sentGb, userId).toBe(single.sentGb);
      expect(fromBulk.receivedGb, userId).toBe(single.receivedGb);
      expect(fromBulk.netGrantedGb, userId).toBe(single.netGrantedGb);
      expect(fromBulk.allocatedGb, userId).toBe(single.allocatedGb);
      expect(fromBulk.availableGb, userId).toBe(single.availableGb);
    }
  });

  it('counts transfers on both sides — the bug the admin user list had', async () => {
    addClaim('sender', 'node-a', 100);
    addTransfer('sender', 'recipient', 40);

    const bulk = await getStorageSummariesForUsers(
      fakePb(),
      ['sender', 'recipient'],
      layout()
    );

    // A raw claim sum would report 100 and 0 here, which is exactly how
    // /admin/users used to disagree with each user's own dashboard.
    expect(bulk.get('sender')!.netGrantedGb).toBe(60);
    expect(bulk.get('recipient')!.netGrantedGb).toBe(40);
  });

  it('excludes claims on nodes missing from the layout', async () => {
    addClaim('u1', 'node-a', 100);
    addClaim('u1', 'node-retired', 500);

    const bulk = await getStorageSummariesForUsers(fakePb(), ['u1'], layout());
    expect(bulk.get('u1')!.netGrantedGb).toBe(100);
  });

  it('returns a zeroed entry for a user with no rows', async () => {
    const bulk = await getStorageSummariesForUsers(
      fakePb(),
      ['nobody'],
      layout()
    );
    expect(bulk.get('nobody')).toMatchObject({
      claimsGb: 0,
      netGrantedGb: 0,
      allocatedGb: 0,
      availableGb: 0,
    });
  });

  it('pages past a single page of results', async () => {
    // 1200 claims exceeds the 500-row page size, so a single-page read would
    // silently under-count — the failure mode this helper exists to avoid.
    for (let i = 0; i < 1200; i += 1) addClaim('u1', 'node-a', 1);

    const bulk = await getStorageSummariesForUsers(fakePb(), ['u1'], layout());
    expect(bulk.get('u1')!.claimsGb).toBe(1200);
  });

  it('reads each collection once per page rather than once per user', async () => {
    for (let i = 0; i < 25; i += 1) {
      addClaim(`u${i}`, 'node-a', 1);
      addBucket(`u${i}`, 1);
    }
    const userIds = Array.from({ length: 25 }, (_, i) => `u${i}`);

    listCalls = 0;
    await getStorageSummariesForUsers(fakePb(), userIds, layout());

    // Three collections, one page each. The per-user path would be ~4 x 25.
    expect(listCalls).toBe(3);
  });

  it('does nothing when given no users', async () => {
    listCalls = 0;
    const bulk = await getStorageSummariesForUsers(fakePb(), [], layout());
    expect(bulk.size).toBe(0);
    expect(listCalls).toBe(0);
  });
});
