import { beforeEach, describe, expect, it } from 'vitest';
import {
  getStorageSummariesForUsers,
  getUserPosition,
  getUserStorageSummary,
} from './summary';
import { computeStorageSummary } from './ledger-math';
import { GIBIBYTE } from './units';
import type { ClusterLayout } from '@/lib/garage';
import type { StorageClaim, StorageTransfer } from '@garage-ware/shared';
import type { TypedPocketBase } from '@/lib/types';

interface FakeClaim {
  id: string;
  user: string;
  node_id: string;
  quota_gb: number;
  created: string;
}
interface FakeTransfer {
  id: string;
  from_user: string;
  to_user: string;
  quota_gb: number;
  created: string;
}
interface FakeNodeBalance {
  id: string;
  user: string;
  node_id: string;
  claimed_gb: number;
  entry_count: number;
}
interface FakeUserBalance {
  id: string;
  user: string;
  claims_gb: number;
  sent_gb: number;
  received_gb: number;
  allocated_gb: number;
}

type FakeCollection =
  'StorageTransfers' | 'StorageNodeBalances' | 'StorageUserBalances';

const store: {
  StorageTransfers: FakeTransfer[];
  StorageNodeBalances: FakeNodeBalance[];
  StorageUserBalances: FakeUserBalance[];
} = {
  StorageTransfers: [],
  StorageNodeBalances: [],
  StorageUserBalances: [],
};

/** Ledger rows kept alongside, so tests can assert cache == ledger. */
const ledger: { claims: FakeClaim[]; transfers: FakeTransfer[] } = {
  claims: [],
  transfers: [],
};
const bucketQuotas = new Map<string, number>();

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
          const rows = store[name] as unknown as Record<string, unknown>[];
          if (!rows) throw new Error(`Unexpected collection read: ${name}`);
          const all = rows.filter((r) => matchesFilter(r, options?.filter));
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
        getFirstListItem(filter: string) {
          listCalls += 1;
          const rows = store[name] as unknown as Record<string, unknown>[];
          if (!rows) throw new Error(`Unexpected collection read: ${name}`);
          const match = rows.find((r) => matchesFilter(r, filter));
          if (!match) {
            // Shape PocketBase's miss so the mutator's allowNotFound path,
            // which is how "this user has no balance row" is expressed, is
            // actually exercised rather than bypassed.
            const err = Object.assign(new Error('Not found'), { status: 404 });
            return Promise.reject(err);
          }
          return Promise.resolve(match);
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
  ledger.claims.push({
    id: `c${seq}`,
    user,
    node_id: nodeId,
    quota_gb: quotaGb,
    created: `2026-01-01 00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
  });
}

function addTransfer(from: string, to: string, quotaGb: number) {
  seq += 1;
  const row: FakeTransfer = {
    id: `t${seq}`,
    from_user: from,
    to_user: to,
    quota_gb: quotaGb,
    created: `2026-01-01 00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
  };
  ledger.transfers.push(row);
  store.StorageTransfers.push(row);
}

function addBucket(user: string, quotaGb: number) {
  bucketQuotas.set(user, (bucketQuotas.get(user) ?? 0) + quotaGb);
}

/**
 * Derive the balance rows from the ledger, exactly as the PocketBase hooks in
 * pb_hooks/lib/storage-balance.js do.
 *
 * Restating the hook's contract in TypeScript is the point: these tests then
 * assert that reading the cache produces the same answer as summing the ledger,
 * which is the property the whole materialization depends on.
 */
function materialize() {
  store.StorageNodeBalances = [];
  store.StorageUserBalances = [];

  const nodeAgg = new Map<string, FakeNodeBalance>();
  const userAgg = new Map<string, FakeUserBalance>();

  const userSlot = (user: string) => {
    let slot = userAgg.get(user);
    if (!slot) {
      slot = {
        id: `ub-${user}`,
        user,
        claims_gb: 0,
        sent_gb: 0,
        received_gb: 0,
        allocated_gb: 0,
      };
      userAgg.set(user, slot);
    }
    return slot;
  };

  for (const claim of ledger.claims) {
    const key = `${claim.user}::${claim.node_id}`;
    let row = nodeAgg.get(key);
    if (!row) {
      row = {
        id: `nb-${key}`,
        user: claim.user,
        node_id: claim.node_id,
        claimed_gb: 0,
        entry_count: 0,
      };
      nodeAgg.set(key, row);
    }
    row.claimed_gb += claim.quota_gb;
    row.entry_count += 1;
    userSlot(claim.user).claims_gb += claim.quota_gb;
  }

  for (const transfer of ledger.transfers) {
    userSlot(transfer.from_user).sent_gb += transfer.quota_gb;
    userSlot(transfer.to_user).received_gb += transfer.quota_gb;
  }

  for (const [user, gb] of bucketQuotas) userSlot(user).allocated_gb += gb;

  store.StorageNodeBalances = [...nodeAgg.values()];
  store.StorageUserBalances = [...userAgg.values()];
}

/** The same position computed straight from the ledger, for comparison. */
function fromLedger(userId: string) {
  return computeStorageSummary(
    ledger.claims.filter((c) => c.user === userId) as unknown as StorageClaim[],
    ledger.transfers.filter(
      (t) => t.from_user === userId
    ) as unknown as StorageTransfer[],
    ledger.transfers.filter(
      (t) => t.to_user === userId
    ) as unknown as StorageTransfer[],
    bucketQuotas.get(userId) ?? 0,
    layout()
  );
}

beforeEach(() => {
  store.StorageTransfers = [];
  store.StorageNodeBalances = [];
  store.StorageUserBalances = [];
  ledger.claims = [];
  ledger.transfers = [];
  bucketQuotas.clear();
  listCalls = 0;
  seq = 0;
});

describe('getUserStorageSummary (balance-backed)', () => {
  it('matches the same position computed from the raw ledger', async () => {
    addClaim('u1', 'node-a', 100);
    addClaim('u1', 'node-a', -20);
    addClaim('u1', 'node-b', 40);
    addTransfer('u1', 'u2', 30);
    addTransfer('u3', 'u1', 5);
    addBucket('u1', 25);
    materialize();

    const cached = await getUserStorageSummary(fakePb(), 'u1', layout());
    const raw = fromLedger('u1');

    // The property the whole materialization rests on.
    expect(cached.claimsGb).toBe(raw.claimsGb);
    expect(cached.sentGb).toBe(raw.sentGb);
    expect(cached.receivedGb).toBe(raw.receivedGb);
    expect(cached.netGrantedGb).toBe(raw.netGrantedGb);
    expect(cached.allocatedGb).toBe(raw.allocatedGb);
    expect(cached.availableGb).toBe(raw.availableGb);
  });

  it('excludes claims on nodes missing from the layout', async () => {
    addClaim('u1', 'node-a', 100);
    addClaim('u1', 'node-retired', 500);
    materialize();

    const summary = await getUserStorageSummary(fakePb(), 'u1', layout());
    expect(summary.netGrantedGb).toBe(100);
    // The retired node is still listed so the UI can explain the difference.
    expect(
      summary.nodeClaims.find((n) => n.nodeId === 'node-retired')
        ?.presentInLayout
    ).toBe(false);
  });

  it('still returns the transfer rows the dashboard lists', async () => {
    addTransfer('u2', 'u1', 15);
    materialize();

    const summary = await getUserStorageSummary(fakePb(), 'u1', layout());
    expect(summary.receivedTransfers).toHaveLength(1);
    expect(summary.receivedGb).toBe(15);
  });

  it('reads a user with no balance row as a zeroed position', async () => {
    materialize();
    const summary = await getUserStorageSummary(fakePb(), 'nobody', layout());
    expect(summary).toMatchObject({
      claimsGb: 0,
      netGrantedGb: 0,
      allocatedGb: 0,
      availableGb: 0,
    });
    expect(summary.nodeClaims).toEqual([]);
  });

  it('is unaffected by ledger length — the cap the ledger sums used to hit', async () => {
    // 5000 entries would have blown past every per-page sum in the old path.
    for (let i = 0; i < 5000; i += 1) addClaim('u1', 'node-a', 1);
    materialize();

    const summary = await getUserStorageSummary(fakePb(), 'u1', layout());
    expect(summary.netGrantedGb).toBe(5000);
    // One roll-up row, regardless of how many entries produced it.
    expect(summary.nodeClaims).toHaveLength(1);
    expect(summary.nodeClaims[0].entryCount).toBe(5000);
  });
});

/**
 * The call every guard on the per-user invariant now makes. It has to give the
 * same numbers as the full summary — the difference is only the two transfer-row
 * queries it does not run — because the whole reason it exists is that the grant
 * and the allocation used to be fetched from two different places and could
 * disagree.
 */
describe('getUserPosition', () => {
  it('agrees with the full summary and skips the transfer reads', async () => {
    addClaim('u1', 'node-a', 100);
    addTransfer('u1', 'u2', 30);
    addTransfer('u3', 'u1', 5);
    addBucket('u1', 25);
    materialize();

    listCalls = 0;
    const position = await getUserPosition(fakePb(), 'u1', layout());
    const positionReads = listCalls;

    listCalls = 0;
    const full = await getUserStorageSummary(fakePb(), 'u1', layout());

    expect(position.netGrantedGb).toBe(full.netGrantedGb);
    expect(position.allocatedGb).toBe(full.allocatedGb);
    expect(position.availableGb).toBe(full.availableGb);
    expect(positionReads).toBeLessThan(listCalls);
    // Balances hold sums, not rows; the handoffs are the caller's business.
    expect(position.sentTransfers).toEqual([]);
  });

  it('values a claim on a node missing from the layout at zero', async () => {
    addClaim('u1', 'node-a', 100);
    addClaim('u1', 'node-gone', 500);
    materialize();

    const position = await getUserPosition(fakePb(), 'u1', layout());

    expect(position.netGrantedGb).toBe(100);
  });

  it('returns a zeroed position for a user with no rows at all', async () => {
    const position = await getUserPosition(fakePb(), 'nobody', layout());

    expect(position.netGrantedGb).toBe(0);
    expect(position.allocatedGb).toBe(0);
    expect(position.availableGb).toBe(0);
  });
});

describe('getStorageSummariesForUsers', () => {
  it('agrees with the per-user read for every user', async () => {
    addClaim('u1', 'node-a', 100);
    addClaim('u2', 'node-b', 50);
    addTransfer('u1', 'u2', 30);
    addBucket('u1', 25);
    addBucket('u2', 60);
    materialize();

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
      expect(fromBulk.netGrantedGb, userId).toBe(single.netGrantedGb);
      expect(fromBulk.allocatedGb, userId).toBe(single.allocatedGb);
      expect(fromBulk.availableGb, userId).toBe(single.availableGb);
    }
  });

  it('counts transfers on both sides — the bug the admin user list had', async () => {
    addClaim('sender', 'node-a', 100);
    addTransfer('sender', 'recipient', 40);
    materialize();

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

  it('returns a zeroed entry for a user with no rows', async () => {
    materialize();
    const bulk = await getStorageSummariesForUsers(
      fakePb(),
      ['nobody'],
      layout()
    );
    expect(bulk.get('nobody')).toMatchObject({
      claimsGb: 0,
      netGrantedGb: 0,
      availableGb: 0,
    });
  });

  it('pages past a single page of balance rows', async () => {
    // 1200 (user, node) pairs exceeds the 500-row page size.
    for (let i = 0; i < 1200; i += 1) addClaim(`u${i}`, 'node-a', 1);
    materialize();

    const userIds = Array.from({ length: 1200 }, (_, i) => `u${i}`);
    const bulk = await getStorageSummariesForUsers(fakePb(), userIds, layout());
    expect(bulk.size).toBe(1200);
    expect(bulk.get('u1199')!.netGrantedGb).toBe(1);
  });

  it('reads each balance collection once per page, not once per user', async () => {
    for (let i = 0; i < 25; i += 1) {
      addClaim(`u${i}`, 'node-a', 1);
      addBucket(`u${i}`, 1);
    }
    materialize();

    listCalls = 0;
    await getStorageSummariesForUsers(
      fakePb(),
      Array.from({ length: 25 }, (_, i) => `u${i}`),
      layout()
    );

    // Two balance collections, one page each. Never per-user.
    expect(listCalls).toBe(2);
  });

  it('does nothing when given no users', async () => {
    listCalls = 0;
    const bulk = await getStorageSummariesForUsers(fakePb(), [], layout());
    expect(bulk.size).toBe(0);
    expect(listCalls).toBe(0);
  });
});
