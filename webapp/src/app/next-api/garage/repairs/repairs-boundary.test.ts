import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The node-id boundary, for the repairs routes — and the one place in the app
 * where a 64-hex string is allowed to exist in a payload.
 *
 * `cluster/node-id-boundary.test.ts` is the original and its whole value is
 * that its assertion has **no exceptions**: any 64 hex characters anywhere in a
 * body fails it. Carving a hole in that file for block hashes would spend the
 * property to save a file. So this is a new file, and it keeps the same blunt
 * assertion by *neutralising the legitimate match first*: each emitted hash
 * prefix is replaced by exact string match, and then the unmodified
 * `not.toMatch(FULL_ID_PATTERN)` runs against what is left. Any *other* 64-hex
 * string still fails.
 *
 * **Why a block hash is not a credential.** The rule exists because a node id's
 * last 48 characters are the proof-of-access `POST /next-api/garage/nodes/
 * owners` accepts — holding one is holding a key. A block hash addresses
 * content and unlocks nothing: this app exposes no endpoint that takes one, and
 * the route truncates them anyway, to 16 characters, for display. If per-hash
 * retry is ever wired, this route will carry full hashes and **this test gets
 * re-argued, not edited**.
 *
 * `/repairs/workers` is covered here too — it was uncovered until now, and it
 * is the older of the two payloads that key an envelope Garage returns by full
 * node id.
 */

const FULL_A =
  '1f104208aab74215c9e3a5f70b1d8c4e2b6079d3af51e8c07d24b93fa6e10852';
const KEY_A = '1f104208aab74215';
const FULL_B =
  '904e16b8b686bd4f11223344556677889900aabbccddeeff0011223344556677';
const KEY_B = '904e16b8b686bd4f';

/**
 * Fixture hashes deliberately share no prefix with either fixture node id — so
 * the substitution below cannot mask a leaked id, and the "is it truncated"
 * assertion cannot pass by accident.
 */
const HASH_1 =
  'deadbeefcafef00d0011223344556677889900aabbccddeeff00112233445566';
const HASH_2 =
  'c0ffee00feed1234ffeeddccbbaa99887766554433221100ffeeddccbbaa9988';

/** Anything that looks like a full node id, anywhere in a payload. */
const FULL_ID_PATTERN = /[0-9a-f]{64}/i;

const garage = vi.hoisted(() => ({
  listBlockErrors: vi.fn(),
  retryBlockResync: vi.fn(),
  listWorkers: vi.fn(),
  getNodeStatistics: vi.fn(),
  getLayout: vi.fn(),
}));

vi.mock('@/lib/garage', async () => {
  const errors = await import('@/lib/garage/errors');
  return {
    GarageClient: { fromEnv: () => ({}) },
    GarageAuthError: errors.GarageAuthError,
    GarageError: errors.GarageError,
    blocks: {
      listBlockErrors: garage.listBlockErrors,
      retryBlockResync: garage.retryBlockResync,
    },
    repair: { listWorkers: garage.listWorkers },
    cluster: {
      getNodeStatistics: garage.getNodeStatistics,
      getLayout: garage.getLayout,
    },
  };
});

vi.mock('@/lib/auth/server', () => ({
  HttpError: class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  errorResponse: (err: { status?: number; message?: string }) =>
    Response.json({ error: err.message }, { status: err.status ?? 500 }),
  requireAdmin: async () => ({
    pb: {},
    user: { id: 'u1', email: 'admin@example.com' },
  }),
}));

vi.mock('@/lib/cluster/timeline-write', () => ({
  writeTimelineActionRow: vi.fn(async () => true),
}));

const layout = {
  version: 3,
  roles: [
    { id: FULL_A, zone: 'dc1', capacity: 1, tags: [] },
    { id: FULL_B, zone: 'dc2', capacity: 1, tags: [] },
  ],
  stagedRoleChanges: [],
  stagedParameters: null,
};

const req = () => new Request('http://test/next-api/garage/repairs/x');

beforeEach(() => {
  vi.clearAllMocks();
  garage.getLayout.mockResolvedValue(layout);
});

describe('GET /next-api/garage/repairs/block-errors', () => {
  it('emits node keys and truncated hashes, and nothing else 64-hex', async () => {
    garage.listBlockErrors.mockResolvedValue([
      {
        nodeId: FULL_A,
        ok: true,
        value: [
          {
            blockHash: HASH_1,
            refcount: 1,
            errorCount: 1,
            lastTrySecsAgo: 1,
            nextTryInSecs: 1,
          },
          {
            blockHash: HASH_2,
            refcount: 1,
            errorCount: 1,
            lastTrySecsAgo: 2,
            nextTryInSecs: 1,
          },
        ],
      },
      { nodeId: FULL_B, ok: false, error: 'unreachable' },
    ]);

    const { GET } = await import('./block-errors/route');
    const body = await (await GET(req())).json();

    expect(body.items.map((i: { nodeId: string }) => i.nodeId)).toEqual([
      KEY_A,
      KEY_B,
    ]);

    const hashes: string[] = body.items.flatMap(
      (i: { items: { hash: string }[] }) => i.items.map((b) => b.hash)
    );
    // Proves truncation rather than assuming it, both ways round.
    expect(hashes).toHaveLength(2);
    for (const hash of hashes) {
      expect(hash).toHaveLength(16);
      expect([HASH_1, HASH_2].some((h) => h.startsWith(hash))).toBe(true);
    }

    // Neutralise the legitimate matches by exact string, then run the blunt
    // assertion unchanged. Anything else 64-hex still fails.
    let raw = JSON.stringify(body);
    for (const hash of hashes) raw = raw.split(hash).join('<hash>');
    expect(raw).not.toMatch(FULL_ID_PATTERN);
  });

  it('echoes the node key on a retry, never the resolved id', async () => {
    garage.retryBlockResync.mockResolvedValue({
      nodeId: FULL_A,
      ok: true,
      value: { count: 7 },
    });

    const { POST } = await import('./block-errors/route');
    const body = await (
      await POST(
        new Request('http://test/x', {
          method: 'POST',
          body: JSON.stringify({ nodeId: KEY_A, all: true }),
        })
      )
    ).json();

    expect(body.nodeId).toBe(KEY_A);
    expect(JSON.stringify(body)).not.toMatch(FULL_ID_PATTERN);
  });
});

describe('GET /next-api/garage/repairs/node-stats', () => {
  it('emits node keys', async () => {
    garage.getNodeStatistics.mockResolvedValue([
      {
        nodeId: FULL_A,
        ok: true,
        value: {
          freeform: 'x',
          blockManagerStats: {
            rcEntries: 1,
            resyncQueueLen: 0,
            resyncErrors: 0,
          },
        },
      },
    ]);

    const { GET } = await import('./node-stats/route');
    const body = await (await GET(req())).json();

    expect(body.items[0].nodeId).toBe(KEY_A);
    expect(JSON.stringify(body)).not.toMatch(FULL_ID_PATTERN);
  });
});

describe('GET /next-api/garage/repairs/workers', () => {
  it('emits node keys, and no full id survives in the freeform lines', async () => {
    // Worker prose is echoed verbatim; this is the assertion that it is echoed
    // from a node's own text and not from an id we put there.
    garage.listWorkers.mockResolvedValue([
      {
        nodeId: FULL_A,
        ok: true,
        value: [
          {
            id: 1,
            name: 'block scrub worker',
            state: 'idle',
            errors: 0,
            consecutiveErrors: 0,
            freeform: ['Last scrub completed at 2026-08-09T03:14:00Z'],
          },
        ],
      },
      { nodeId: FULL_B, ok: false, error: 'unreachable' },
    ]);

    const { GET } = await import('./workers/route');
    const body = await (await GET(req())).json();

    expect(body.items.map((i: { nodeId: string }) => i.nodeId)).toEqual([
      KEY_A,
      KEY_B,
    ]);
    expect(JSON.stringify(body)).not.toMatch(FULL_ID_PATTERN);
  });
});
