import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/next-api/garage/claims`, on the two things node ownership added to it.
 *
 * Both are about the same mistake in two places: a node is identified by its
 * **key** everywhere in this app, and reading a node's claims through the
 * *caller's* client is not the same as reading the node's claims.
 *
 * - `GET ?nodeId=` must return every user's entries on that node. Under the
 *   caller's own client the StorageClaims listRule (`user = self || admin`)
 *   silently scopes it to their own rows, and `/dashboard/nodes` then subtracts
 *   the wrong number from the node's capacity and offers storage that is not
 *   there.
 * - the ownership check in `POST` must run against the key, because that is what
 *   `NodeOwners.node_id` stores. Checking the raw body value 403s the node's
 *   actual owner whenever they send a full id.
 */

const KEY = 'a1b2c3d4e5f60718';
const FULL = KEY + '0123456789abcdef'.repeat(3);

const SUPERUSER = { tag: 'superuser' };
const CALLER = { tag: 'caller' };

const hooks = vi.hoisted(() => ({
  assertNodeOwner: vi.fn(),
  isUserAdmin: vi.fn(),
  listByNode: vi.fn(),
  /** Which client each StorageClaimMutator was constructed with. */
  builtWith: [] as unknown[],
}));

vi.mock('@garage-ware/shared/mutators', () => ({
  StorageClaimMutator: class {
    constructor(pb: unknown) {
      hooks.builtWith.push(pb);
    }
    listByNode = hooks.listByNode;
    listByUser = vi.fn(async () => ({ items: [] }));
    getList = vi.fn(async () => ({ items: [] }));
  },
}));

vi.mock('@/lib/auth/ownership', () => ({
  assertNodeOwner: hooks.assertNodeOwner,
}));

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
  getServerUser: async () => ({
    pb: CALLER,
    user: { id: 'u1', email: 'u1@example.com' },
  }),
  getPbAsSuperuser: async () => SUPERUSER,
  isUserAdmin: hooks.isUserAdmin,
}));

vi.mock('@/lib/garage', () => ({
  GarageClient: { fromEnv: () => ({}) },
  cluster: { getStatus: vi.fn(async () => ({ nodes: [] })) },
}));
vi.mock('@/lib/storage/claim-ledger', () => ({
  assertClaimDeltaAllowed: vi.fn(),
  loadClaimContext: vi.fn(async () => ({ layout: { roles: [] } })),
}));
vi.mock('@/lib/storage/claim-write', () => ({ actorHeaders: () => ({}) }));
vi.mock('@/lib/storage/invites', () => ({ findUserIdByEmail: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  hooks.builtWith.length = 0;
  hooks.assertNodeOwner.mockResolvedValue({ isAdmin: false });
  hooks.listByNode.mockResolvedValue({ items: [{ id: 'c1', quota_gb: 10 }] });
  hooks.isUserAdmin.mockResolvedValue(false);
});

describe('GET /next-api/garage/claims?nodeId=', () => {
  it('reads the node as a superuser, not through the caller', async () => {
    const { GET } = await import('./route');

    const res = await GET(new Request(`http://test/x?nodeId=${KEY}`));

    expect(res.status).toBe(200);
    // The mutator that actually ran the node query is the last one built, and
    // it must hold the superuser client — the caller's own would return only
    // their own entries and understate what the node has promised.
    expect(hooks.builtWith.at(-1)).toBe(SUPERUSER);
    expect(hooks.listByNode).toHaveBeenCalledWith(KEY);
  });

  it('normalises the node id to a key before asserting ownership', async () => {
    const { GET } = await import('./route');

    await GET(new Request(`http://test/x?nodeId=${KEY.toUpperCase()}`));

    expect(hooks.assertNodeOwner).toHaveBeenCalledWith(CALLER, KEY, 'u1');
    expect(hooks.listByNode).toHaveBeenCalledWith(KEY);
  });

  it('does not read the node at all when ownership is refused', async () => {
    hooks.assertNodeOwner.mockRejectedValue(
      Object.assign(new Error('You do not own this node'), { status: 403 })
    );
    const { GET } = await import('./route');

    const res = await GET(new Request(`http://test/x?nodeId=${KEY}`));

    expect(res.status).toBe(403);
    expect(hooks.listByNode).not.toHaveBeenCalled();
  });
});

describe('POST /next-api/garage/claims ownership check', () => {
  it('checks ownership against the key, not the submitted id', async () => {
    const { POST } = await import('./route');

    // A full id is a legal body here (node_id accepts up to 128 chars), and
    // NodeOwners stores keys — so the lookup has to be normalised or the
    // node's own owner is refused.
    await POST(
      new Request('http://test/x', {
        method: 'POST',
        body: JSON.stringify({
          node_id: FULL,
          user_id: 'u2',
          quota_gb: 5,
        }),
      })
    );

    expect(hooks.assertNodeOwner).toHaveBeenCalledWith(
      CALLER,
      KEY,
      'u1',
      false
    );
  });

  it('skips the ownership check entirely for an admin', async () => {
    hooks.isUserAdmin.mockResolvedValue(true);
    const { POST } = await import('./route');

    await POST(
      new Request('http://test/x', {
        method: 'POST',
        body: JSON.stringify({ node_id: KEY, user_id: 'u2', quota_gb: 5 }),
      })
    );

    expect(hooks.assertNodeOwner).not.toHaveBeenCalled();
  });
});
