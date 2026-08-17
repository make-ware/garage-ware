import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /next-api/garage/nodes/owners` — the admission test, which is the one
 * in this app that must not be relaxed by accident.
 *
 * There are two authorities here and they submit different things. A user
 * claiming a node proves possession of its **full** 64-character id. An admin
 * assigning one submits the 16-character **key**, because that is the only node
 * identifier the admin console has — no route emits a full id and no page
 * renders one, so `/admin/nodes` could not produce the credential even in
 * principle, and requiring it there made admin assignment a permanent 400.
 *
 * The test that matters most is the negative one: a key must still be refused
 * from a non-admin, or the public key on every screen becomes the credential.
 */

const KEY = 'a1b2c3d4e5f60718';
const FULL = KEY + '0123456789abcdef'.repeat(3);

const layout = vi.hoisted(() => ({ getLayout: vi.fn() }));
const auth = vi.hoisted(() => ({ isUserAdmin: vi.fn(), create: vi.fn() }));

vi.mock('@/lib/garage', () => ({
  GarageClient: { fromEnv: () => ({}) },
  cluster: { getLayout: layout.getLayout },
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
    pb: {},
    user: { id: 'u1', email: 'u1@example.com' },
  }),
  getPbAsSuperuser: async () => ({
    collection: () => ({ create: auth.create }),
  }),
  isUserAdmin: auth.isUserAdmin,
}));

vi.mock('@/lib/cluster/timeline-write', () => ({
  writeTimelineActionRow: async () => true,
}));

vi.mock('@garage-ware/shared/mutators', () => ({
  NodeOwnerMutator: class {},
}));

const post = (body: unknown) =>
  new Request('http://test/x', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  layout.getLayout.mockResolvedValue({
    version: 1,
    roles: [{ id: FULL, zone: 'dc1', capacity: 1_000_000 }],
  });
  auth.create.mockImplementation(async (data: unknown) => ({
    id: 'own1',
    ...(data as object),
  }));
});

describe('POST /next-api/garage/nodes/owners', () => {
  it('refuses a bare node key from a non-admin — the key is public', async () => {
    auth.isUserAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');

    const res = await POST(post({ node_id: KEY }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('full 64-character node id');
    expect(auth.create).not.toHaveBeenCalled();
  });

  it('accepts a full id from a non-admin and stores only the key', async () => {
    auth.isUserAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');

    const res = await POST(post({ node_id: FULL }));

    expect(res.status).toBe(200);
    expect(auth.create).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'u1', node_id: KEY })
    );
    // The credential must not reach the database.
    expect(JSON.stringify(auth.create.mock.calls)).not.toContain(FULL);
  });

  it('accepts a bare key from an admin assigning on behalf of a user', async () => {
    auth.isUserAdmin.mockResolvedValue(true);
    const { POST } = await import('./route');

    // Exactly what /admin/nodes sends: the key from GET /cluster/nodes.
    const res = await POST(post({ node_id: KEY, user_id: 'u2' }));

    expect(res.status).toBe(200);
    expect(auth.create).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'u2', node_id: KEY })
    );
  });

  it('resolves the caller admin status once, not once per question', async () => {
    auth.isUserAdmin.mockResolvedValue(true);
    const { POST } = await import('./route');

    // Both questions are asked on this path: may they name another owner, and
    // is a bare key enough.
    await POST(post({ node_id: KEY, user_id: 'u2' }));

    expect(auth.isUserAdmin).toHaveBeenCalledOnce();
  });

  it('splits the id@address form `garage node id` actually prints', async () => {
    auth.isUserAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');

    const res = await POST(post({ node_id: `${FULL}@10.0.0.4:3901` }));

    expect(res.status).toBe(200);
    expect(auth.create).toHaveBeenCalledWith(
      expect.objectContaining({ node_id: KEY })
    );
  });

  it('rejects a value that is neither a key nor a full id', async () => {
    auth.isUserAdmin.mockResolvedValue(true);
    const { POST } = await import('./route');

    const res = await POST(post({ node_id: 'vault-01' }));

    expect(res.status).toBe(400);
    expect(auth.create).not.toHaveBeenCalled();
  });

  it('404s a key an admin submits for a node not in the layout', async () => {
    auth.isUserAdmin.mockResolvedValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST } = await import('./route');

    const res = await POST(
      post({ node_id: 'ffffffffffffffff', user_id: 'u2' })
    );

    expect(res.status).toBe(404);
    expect(auth.create).not.toHaveBeenCalled();
  });
});
