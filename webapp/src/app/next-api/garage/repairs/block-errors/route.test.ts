import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET`/`POST /next-api/garage/repairs/block-errors`.
 *
 * Four things here are load-bearing beyond "does it work":
 *
 *  - **The cap is visible.** `ListBlockErrors` is unpaginated, so a dead drive
 *    can return millions of rows. The route slices, and `totalErrors` carries
 *    the untruncated count so the card can say "Showing 25 of 41,233".
 *  - **A per-node failure is a row, not an HTTP error.** One dead node must not
 *    blank the card for the rest of the cluster, and must never read as zero.
 *  - **A missing token scope names itself.** Every install predating this
 *    release has a token without `ListBlockErrors`, and the generic
 *    "check GARAGE_ADMIN_TOKEN" 502 would send an operator to a token that is
 *    set correctly.
 *  - **The retry is not a repair action.** It carries no action parameter at
 *    all, resolves a key to a full id, and writes one `kind:'repair'` row whose
 *    `new_value` is the raw op id and whose `detail` carries the count.
 */

const KEY_A = 'aaaa000000000001';
const KEY_B = 'bbbb000000000002';
const FULL_A = KEY_A + '0123456789abcdef'.repeat(3);
const FULL_B = KEY_B + '0123456789abcdef'.repeat(3);

const garage = vi.hoisted(() => ({
  listBlockErrors: vi.fn(),
  retryBlockResync: vi.fn(),
  getLayout: vi.fn(),
}));
const timeline = vi.hoisted(() => ({ write: vi.fn() }));

vi.mock('@/lib/garage', async () => {
  // The real error classes: the route discriminates on them, so stubbing them
  // would test a different route than the one that ships.
  const errors = await import('@/lib/garage/errors');
  return {
    GarageClient: { fromEnv: () => ({}) },
    GarageAuthError: errors.GarageAuthError,
    GarageError: errors.GarageError,
    blocks: {
      listBlockErrors: garage.listBlockErrors,
      retryBlockResync: garage.retryBlockResync,
    },
    cluster: { getLayout: garage.getLayout },
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
  writeTimelineActionRow: timeline.write,
}));

const layout = {
  version: 12,
  roles: [
    { id: FULL_A, zone: 'dc1', capacity: 1, tags: ['name:vault-01'] },
    { id: FULL_B, zone: 'dc2', capacity: 1, tags: [] },
  ],
  stagedRoleChanges: [],
  stagedParameters: null,
};

const blockError = (over: Record<string, unknown> = {}) => ({
  blockHash: 'ff'.repeat(32),
  refcount: 1,
  errorCount: 1,
  lastTrySecsAgo: 10,
  nextTryInSecs: 10,
  ...over,
});

const get = () =>
  new Request('http://test/next-api/garage/repairs/block-errors');
const post = (body: unknown) =>
  new Request('http://test/x', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  garage.getLayout.mockResolvedValue(layout);
  timeline.write.mockResolvedValue(true);
});

describe('GET /next-api/garage/repairs/block-errors', () => {
  it('keys node ids and truncates hashes to 16 characters', async () => {
    garage.listBlockErrors.mockResolvedValue([
      { nodeId: FULL_A, ok: true, value: [blockError()] },
    ]);

    const { GET, BLOCK_HASH_DISPLAY_CHARS } = await import('./route');
    const body = await (await GET(get())).json();

    expect(body.items[0].nodeId).toBe(KEY_A);
    expect(body.items[0].items[0].hash).toHaveLength(BLOCK_HASH_DISPLAY_CHARS);
    expect('ff'.repeat(32).startsWith(body.items[0].items[0].hash)).toBe(true);
  });

  it('caps the rows and reports the untruncated count', async () => {
    const forty = Array.from({ length: 40 }, (_, i) =>
      blockError({ blockHash: i.toString(16).padStart(64, '0') })
    );
    garage.listBlockErrors.mockResolvedValue([
      { nodeId: FULL_A, ok: true, value: forty },
    ]);

    const { GET, MAX_BLOCK_ERRORS_PER_NODE } = await import('./route');
    const body = await (await GET(get())).json();

    expect(body.items[0].items).toHaveLength(MAX_BLOCK_ERRORS_PER_NODE);
    // The number the card renders. A cap that only existed in `items.length`
    // would read as "25 blocks are broken" when 40 are.
    expect(body.items[0].totalErrors).toBe(40);
    expect(body.items[0].truncated).toBe(true);
    expect(body.perNodeLimit).toBe(MAX_BLOCK_ERRORS_PER_NODE);
  });

  it('orders by soonest retry, then by failure count', async () => {
    // Shuffled on the way in: Garage guarantees no ordering, so the assertion
    // has to be that we imposed one.
    garage.listBlockErrors.mockResolvedValue([
      {
        nodeId: FULL_A,
        ok: true,
        value: [
          blockError({ blockHash: 'c'.repeat(64), lastTrySecsAgo: 500 }),
          blockError({
            blockHash: 'a'.repeat(64),
            lastTrySecsAgo: 10,
            errorCount: 2,
          }),
          blockError({
            blockHash: 'b'.repeat(64),
            lastTrySecsAgo: 10,
            errorCount: 9,
          }),
        ],
      },
    ]);

    const { GET } = await import('./route');
    const body = await (await GET(get())).json();

    expect(body.items[0].items.map((i: { hash: string }) => i.hash[0])).toEqual(
      ['b', 'a', 'c']
    );
  });

  it('carries a per-node failure at 200, with no items and no zero count', async () => {
    garage.listBlockErrors.mockResolvedValue([
      { nodeId: FULL_A, ok: false, error: 'node unreachable' },
      { nodeId: FULL_B, ok: true, value: [] },
    ]);

    const { GET } = await import('./route');
    const res = await GET(get());
    const body = await res.json();

    expect(res.status).toBe(200);
    const failed = body.items.find(
      (i: { nodeId: string }) => i.nodeId === KEY_A
    );
    expect(failed.error).toBe('node unreachable');
    expect(failed.items).toEqual([]);
  });

  it('names the operation and the scope when Garage returns 403', async () => {
    const { GarageAuthError } = await import('@/lib/garage/errors');
    garage.listBlockErrors.mockRejectedValue(
      new GarageAuthError('/v2/ListBlockErrors', {})
    );

    const { GET } = await import('./route');
    const res = await GET(get());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain('ListBlockErrors');
    expect(body.error).toContain('scope');
    // The generic advice would send an operator to a correctly-set token.
    expect(body.error).not.toContain('GARAGE_ADMIN_TOKEN');
  });

  it('explains a timeout as a backlog rather than an outage', async () => {
    const { GarageError } = await import('@/lib/garage/errors');
    garage.listBlockErrors.mockRejectedValue(
      new GarageError('Garage did not respond in time', {
        status: 0,
        endpoint: '/v2/ListBlockErrors',
        code: 'timeout',
      })
    );

    const { GET } = await import('./route');
    const res = await GET(get());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).toContain('more errored blocks than could be read');
  });
});

describe('POST /next-api/garage/repairs/block-errors', () => {
  it('resolves the key to a full id and echoes the key back', async () => {
    garage.retryBlockResync.mockResolvedValue({
      nodeId: FULL_A,
      ok: true,
      value: { count: 41_233 },
    });

    const { POST } = await import('./route');
    const res = await POST(post({ nodeId: KEY_A, all: true }));
    const body = await res.json();

    expect(garage.retryBlockResync).toHaveBeenCalledWith(expect.anything(), {
      nodeId: FULL_A,
      request: { all: true },
    });
    expect(body).toMatchObject({ ok: true, nodeId: KEY_A, count: 41_233 });
    expect(JSON.stringify(body)).not.toContain(FULL_A);
  });

  it('writes exactly one repair row carrying the count in detail', async () => {
    garage.retryBlockResync.mockResolvedValue({
      nodeId: FULL_A,
      ok: true,
      value: { count: 12 },
    });

    const { POST } = await import('./route');
    await POST(post({ nodeId: KEY_A, all: true }));

    expect(timeline.write).toHaveBeenCalledTimes(1);
    expect(timeline.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'repair',
        // The raw op id, as everything else in this collection is raw. The
        // count goes in `detail`, which is where a reader looks for it three
        // weeks later.
        newValue: 'retry-resync',
        severity: 'info',
        nodeId: KEY_A,
        detail: expect.stringContaining('12'),
      })
    );
  });

  it('records a refused retry at warning and answers 502', async () => {
    garage.retryBlockResync.mockResolvedValue({
      nodeId: FULL_A,
      ok: false,
      error: 'block store offline',
    });

    const { POST } = await import('./route');
    const res = await POST(post({ nodeId: KEY_A, all: true }));

    // 502, not a 200 with ok:false — that would rebuild Garage's own trap at
    // our boundary.
    expect(res.status).toBe(502);
    expect(timeline.write).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warning' })
    );
  });

  it('treats a null outcome as a failure', async () => {
    garage.retryBlockResync.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(post({ nodeId: KEY_A, all: true }))).status).toBe(502);
  });

  it('still succeeds when the timeline row could not be written', async () => {
    // The retry already happened. Telling the operator it did not makes them
    // click again — the StorageInvites email precedent.
    timeline.write.mockResolvedValue(false);
    garage.retryBlockResync.mockResolvedValue({
      nodeId: FULL_A,
      ok: true,
      value: { count: 3 },
    });

    const { POST } = await import('./route');
    const res = await POST(post({ nodeId: KEY_A, all: true }));

    expect(res.status).toBe(200);
    expect((await res.json()).logged).toBe(false);
  });

  it.each([
    ['a wildcard', { nodeId: '*', all: true }],
    ['self', { nodeId: 'self', all: true }],
    ['a full node id', { nodeId: FULL_A, all: true }],
    ['a blockHashes body', { nodeId: KEY_A, blockHashes: ['ab'] }],
    ['all: false', { nodeId: KEY_A, all: false }],
    ['an extra key', { nodeId: KEY_A, all: true, blockHashes: ['ab'] }],
  ])('rejects %s with a 400', async (_label, body) => {
    const { POST } = await import('./route');
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(garage.retryBlockResync).not.toHaveBeenCalled();
  });

  it('reports an unknown node key as a 404 from the resolver', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ nodeId: 'cccc000000000009', all: true }));
    expect(res.status).toBe(404);
  });
});
