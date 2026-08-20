import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The boundary guard: **no route handler may emit a full node id.**
 *
 * A Garage node id is 64 hex characters; its first 16 are the public node key
 * and the remaining 48 are the credential `POST /next-api/garage/nodes/owners`
 * accepts as proof of access to the machine. That rule used to be an ACCEPTED
 * GAP precisely because it was maintained by review — `/cluster/nodes` emitted
 * `id` untruncated to every page in the app, and nothing failed when it did.
 *
 * So the assertion here is deliberately blunt and made against the whole
 * serialized body rather than against a named field: the next handler somebody
 * adds should fail this without anyone having to remember the rule. It runs the
 * real handlers, with only their auth and their Garage reads mocked.
 */

const FULL_A =
  '1f104208aab74215c9e3a5f70b1d8c4e2b6079d3af51e8c07d24b93fa6e10852';
const FULL_B =
  '904e16b8b686bd4f11223344556677889900aabbccddeeff0011223344556677';
const KEY_A = '1f104208aab74215';
const KEY_B = '904e16b8b686bd4f';

/** Anything that looks like a full node id, anywhere in a payload. */
const FULL_ID_PATTERN = /[0-9a-f]{64}/i;

const layout = {
  version: 12,
  roles: [
    { id: FULL_A, zone: 'pdx1', capacity: 56_000_000_000_000, tags: ['ssd'] },
    { id: FULL_B, zone: 'sea1', capacity: 120_000_000_000_000, tags: [] },
  ],
  // Staged changes carry ids too, and this fixture used to have none — which
  // is exactly why `/cluster/layout` emitted full ids through its spread for as
  // long as it did, without failing anything here.
  stagedRoleChanges: [
    { id: FULL_A, zone: 'pdx1', capacity: 64_000_000_000_000, tags: ['ssd'] },
    { id: FULL_B, remove: true },
  ],
  stagedParameters: null,
};

const status = {
  layoutVersion: 12,
  nodes: [
    {
      id: FULL_A,
      isUp: true,
      draining: false,
      // The address is admin-only and deliberately never emitted by
      // /cluster/nodes; /cluster/status does carry it, and that is not what
      // this file is testing.
      addr: '10.0.0.1:3901',
      hostname: 'd7f41e63183e',
      garageVersion: 'v2.3.0',
      lastSeenSecsAgo: 4,
      dataPartition: { total: 100, available: 40 },
      metadataPartition: { total: 10, available: 9 },
    },
    { id: FULL_B, isUp: false, draining: false },
  ],
};

vi.mock('@/lib/auth/server', () => ({
  getServerUser: vi.fn(async () => ({ pb: {}, user: { id: 'u1' } })),
  requireAdmin: vi.fn(async () => ({ pb: {}, user: { id: 'u1' } })),
  errorResponse: (err: unknown) =>
    Response.json({ error: String(err) }, { status: 500 }),
  HttpError: class extends Error {},
}));

vi.mock('@/lib/garage/cached', () => ({
  getCachedLayout: vi.fn(async () => layout),
  getCachedStatus: vi.fn(async () => status),
  getCachedHealth: vi.fn(async () => ({})),
  getCachedReplicationFactor: vi.fn(async () => 3),
}));

const req = () => new Request('http://test/next-api/garage/cluster/nodes');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /next-api/garage/cluster/nodes', () => {
  it('emits node keys, never full ids', async () => {
    const { GET } = await import('./nodes/route');
    const body = await (await GET(req())).json();

    expect(body.items.map((i: { id: string }) => i.id)).toEqual([KEY_A, KEY_B]);
    expect(JSON.stringify(body)).not.toMatch(FULL_ID_PATTERN);
  });

  it('still carries what the pages actually need', async () => {
    // The point is to redact the id, not to break the payload — every one of
    // these feeds a chart, a badge or the capacity arithmetic.
    const { GET } = await import('./nodes/route');
    const body = await (await GET(req())).json();

    expect(body.items[0]).toMatchObject({
      zone: 'pdx1',
      capacity: 56_000_000_000_000,
      isUp: true,
      diskTotalBytes: 100,
    });
    expect(body.replicationFactor).toBe(3);
    expect(body.layoutVersion).toBe(12);
  });

  it('emits no hostname and no network address', async () => {
    const { GET } = await import('./nodes/route');
    const raw = JSON.stringify(await (await GET(req())).json());

    expect(raw).not.toContain('d7f41e63183e');
    expect(raw).not.toContain('10.0.0.1');
  });
});

describe('GET /next-api/garage/cluster/status', () => {
  it('emits node keys even though it is admin-only', async () => {
    // Admins are not exempt: the full id is a credential, and the only thing
    // that reads this payload joins it against keys from everywhere else.
    const { GET } = await import('./status/route');
    const body = await (await GET(req())).json();

    expect(body.nodes.map((n: { id: string }) => n.id)).toEqual([KEY_A, KEY_B]);
    expect(JSON.stringify(body)).not.toMatch(FULL_ID_PATTERN);
  });
});

describe('GET /next-api/garage/cluster/layout', () => {
  it('emits node keys in the role list', async () => {
    const { GET } = await import('./layout/route');
    const body = await (await GET(req())).json();

    expect(body.roles.map((r: { id: string }) => r.id)).toEqual([KEY_A, KEY_B]);
    expect(JSON.stringify(body)).not.toMatch(FULL_ID_PATTERN);
  });

  it('keys the staged changes too', async () => {
    const { GET } = await import('./layout/route');
    const body = await (await GET(req())).json();

    expect(body.stagedRoleChanges.map((c: { id: string }) => c.id)).toEqual([
      KEY_A,
      KEY_B,
    ]);
  });
});

describe('GET /next-api/garage/cluster/staging', () => {
  it('keys the roles, the staged changes and the candidate list', async () => {
    // The action surface reads live rather than through the cache, so it gets
    // its own mocks — and it is the route most likely to grow a field that
    // carries an id.
    vi.doMock('@/lib/garage', () => ({
      GarageClient: { fromEnv: () => ({}) },
      cluster: {
        getLayout: async () => layout,
        getStatus: async () => status,
        getReplicationFactor: async () => 3,
      },
    }));
    const { GET } = await import('./staging/route');
    const body = await (await GET(req())).json();

    expect(body.roles.map((r: { id: string }) => r.id)).toEqual([KEY_A, KEY_B]);
    expect(body.staged.map((c: { id: string }) => c.id)).toEqual([
      KEY_A,
      KEY_B,
    ]);
    expect(body.candidates.map((c: { id: string }) => c.id)).toEqual([
      KEY_A,
      KEY_B,
    ]);
    expect(JSON.stringify(body)).not.toMatch(FULL_ID_PATTERN);
    vi.doUnmock('@/lib/garage');
  });
});
