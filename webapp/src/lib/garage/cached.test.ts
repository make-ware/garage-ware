import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cluster read cache is what makes a dashboard load cost no Garage round
 * trips, so what matters is not that it returns the right shape but *when it
 * calls Garage* and *what it does when Garage is gone*. Every test here counts
 * fetches or kills them.
 *
 * Driven against a fake PocketBase (the collection's rules are all null, so the
 * real code only ever reaches it through the superuser client) and a mocked
 * `globalThis.fetch`, the pattern from garage-client.test.ts.
 */

interface Row {
  id: string;
  key: string;
  payload: unknown;
  fetched_at?: string;
  created: string;
  updated: string;
}

const store = {
  rows: [] as Row[],
  /** Set to make the next create fail the way a lost unique-index race does. */
  raceNextCreate: false,
  creates: 0,
};

function notFound(): Error {
  return Object.assign(new Error("The requested resource wasn't found."), {
    status: 404,
  });
}

const fakePb = {
  collection(name: string) {
    if (name !== 'GarageClusterCache') {
      throw new Error(`unexpected collection ${name}`);
    }
    return {
      async getFirstListItem(filter: string) {
        const key = /key = "([^"]*)"/.exec(filter)?.[1];
        const row = store.rows.find((r) => r.key === key);
        if (!row) throw notFound();
        return row;
      },
      async create(data: Record<string, unknown>) {
        store.creates += 1;
        if (store.raceNextCreate) {
          store.raceNextCreate = false;
          // The winner's row is already committed; the loser sees the index.
          store.rows.push({
            id: `r${store.rows.length + 1}`,
            key: String(data.key),
            payload: { version: 99, roles: [] },
            fetched_at: new Date().toISOString(),
            created: '',
            updated: '',
          });
          throw Object.assign(
            new Error('Failed to create record. UNIQUE constraint failed.'),
            { status: 400 }
          );
        }
        const row: Row = {
          id: `r${store.rows.length + 1}`,
          key: String(data.key),
          payload: data.payload,
          fetched_at: data.fetched_at as string | undefined,
          created: '',
          updated: '',
        };
        store.rows.push(row);
        return row;
      },
      async update(id: string, data: Record<string, unknown>) {
        const row = store.rows.find((r) => r.id === id);
        if (!row) throw notFound();
        Object.assign(row, data);
        return row;
      },
    };
  },
};

vi.mock('@/lib/auth/server', () => ({
  getPbAsSuperuser: async () => fakePb,
  HttpError: class extends Error {},
}));

const { getCachedLayout, getCachedReplicationFactor } =
  await import('@/lib/garage/cached');

const LAYOUT_V1 = {
  version: 1,
  roles: [{ id: 'n1', zone: 'dc1', capacity: 1_000, tags: [] }],
};
const LAYOUT_V2 = {
  version: 2,
  roles: [{ id: 'n1', zone: 'dc1', capacity: 2_000, tags: [] }],
};

const MINUTE = 60_000;

function seed(key: string, payload: unknown, ageMs: number): void {
  store.rows.push({
    id: `seed-${key}`,
    key,
    payload,
    fetched_at: new Date(Date.now() - ageMs).toISOString(),
    created: '',
    updated: '',
  });
}

/** Respond to every Garage call with `body`, counting the calls. */
function garageReturns(body: unknown): { calls: () => number } {
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status: 200 })
    );
  return { calls: () => spy.mock.calls.length };
}

function garageIsDown(): void {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
}

beforeEach(() => {
  store.rows = [];
  store.raceNextCreate = false;
  store.creates = 0;
  process.env.GARAGE_ADMIN_URL = 'http://garage.test';
  process.env.GARAGE_ADMIN_TOKEN = 'test-token';
  // A cache miss is a 404 the mutator logs, and a stale-payload read warns.
  // Both are expected here; keep the output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getCachedLayout', () => {
  it('fetches live on a miss and writes the row through', async () => {
    const garage = garageReturns(LAYOUT_V1);

    const layout = await getCachedLayout();

    expect(layout).toEqual(LAYOUT_V1);
    expect(garage.calls()).toBe(1);
    const row = store.rows.find((r) => r.key === 'layout');
    expect(row?.payload).toEqual(LAYOUT_V1);
    expect(row?.fetched_at).toBeTruthy();
  });

  it('serves a fresh row without touching Garage at all', async () => {
    seed('layout', LAYOUT_V1, 5_000);
    const garage = garageReturns(LAYOUT_V2);

    expect(await getCachedLayout()).toEqual(LAYOUT_V1);
    expect(garage.calls()).toBe(0);
  });

  it('returns a stale row immediately, then refreshes behind the response', async () => {
    seed('layout', LAYOUT_V1, 5 * MINUTE);
    const garage = garageReturns(LAYOUT_V2);

    // The caller gets the old value — that is the whole point of serving stale.
    expect(await getCachedLayout()).toEqual(LAYOUT_V1);

    await vi.waitFor(() => {
      expect(store.rows[0].payload).toEqual(LAYOUT_V2);
    });
    expect(garage.calls()).toBe(1);
  });

  it('refreshes once when several requests hit the same stale key', async () => {
    // One dashboard load fans out into three handlers that all want the
    // layout. Without in-process dedup that is three GetClusterLayout calls
    // against the thing being cached.
    seed('layout', LAYOUT_V1, 5 * MINUTE);
    const garage = garageReturns(LAYOUT_V2);

    const results = await Promise.all([
      getCachedLayout(),
      getCachedLayout(),
      getCachedLayout(),
    ]);

    expect(results).toEqual([LAYOUT_V1, LAYOUT_V1, LAYOUT_V1]);
    await vi.waitFor(() => {
      expect(store.rows[0].payload).toEqual(LAYOUT_V2);
    });
    expect(garage.calls()).toBe(1);
  });

  it('treats a payload the schema no longer accepts as a miss', async () => {
    // Garage v2 is documented as an early implementation that may change; a row
    // written under an older shape must not be handed to a caller.
    seed('layout', { nonsense: true }, 1_000);
    const garage = garageReturns(LAYOUT_V2);

    expect(await getCachedLayout()).toEqual(LAYOUT_V2);
    expect(garage.calls()).toBe(1);
  });

  it('recovers from losing the create race by updating the winner row', async () => {
    store.raceNextCreate = true;
    const garage = garageReturns(LAYOUT_V2);

    const layout = await getCachedLayout();

    expect(layout).toEqual(LAYOUT_V2);
    expect(garage.calls()).toBe(1);
    // One row, holding this process's payload rather than the winner's.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].payload).toEqual(LAYOUT_V2);
  });

  it('serves a stale row whatever its age when Garage is unreachable', async () => {
    // No maximum staleness on purpose: an outage is exactly what the cache is
    // for, and the alternative is an error page.
    seed('layout', LAYOUT_V1, 30 * 24 * 60 * MINUTE);
    garageIsDown();

    expect(await getCachedLayout()).toEqual(LAYOUT_V1);
  });

  it('throws when Garage is unreachable and nothing has ever been cached', async () => {
    garageIsDown();
    await expect(getCachedLayout()).rejects.toThrow();
  });
});

describe('getCachedReplicationFactor', () => {
  it('stores the factor wrapped in an object so every payload is JSON', async () => {
    garageReturns({ replicationFactor: 3, freeform: 'whatever' });

    expect(await getCachedReplicationFactor()).toBe(3);
    expect(
      store.rows.find((r) => r.key === 'replication_factor')?.payload
    ).toEqual({ replicationFactor: 3 });
  });

  it('serves a fresh factor without touching Garage', async () => {
    seed('replication_factor', { replicationFactor: 2 }, MINUTE);
    const garage = garageReturns({ replicationFactor: 3 });

    expect(await getCachedReplicationFactor()).toBe(2);
    expect(garage.calls()).toBe(0);
  });
});
