import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stagedFingerprint } from '@/lib/cluster/staged-changes';

/**
 * `POST /next-api/garage/cluster/staging` — the one layout mutation this app
 * makes, and the guards around it.
 *
 * Two things here are load-bearing beyond "does it work". The **conflict
 * check**, because Garage offers none: `UpdateClusterLayout` takes no version
 * and no CAS parameter, it merges whatever it is sent into whatever is already
 * staged, and answers 200 — so two admins staging different capacities for one
 * node silently produce one staging area that a single `apply` commits. And the
 * **key/full-id boundary**: the browser names a 16-character node key, Garage
 * is called with the 64-character id, and neither may be mistaken for the
 * other in either direction.
 */

const KEY_A = 'aaaa000000000001';
const KEY_B = 'bbbb000000000002';
const KEY_NEW = 'cccc000000000003';
const FULL_A = KEY_A + '0123456789abcdef'.repeat(3);
const FULL_B = KEY_B + '0123456789abcdef'.repeat(3);
const FULL_NEW = KEY_NEW + '0123456789abcdef'.repeat(3);

const TB = 1_000_000_000_000;

const garage = vi.hoisted(() => ({
  getLayout: vi.fn(),
  getStatus: vi.fn(),
  getReplicationFactor: vi.fn(),
  updateLayout: vi.fn(),
}));
const timeline = vi.hoisted(() => ({ write: vi.fn() }));

vi.mock('@/lib/garage', () => ({
  GarageClient: { fromEnv: () => ({}) },
  cluster: garage,
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
  requireAdmin: async () => ({
    pb: {},
    user: { id: 'u1', email: 'admin@example.com' },
  }),
}));

vi.mock('@/lib/cluster/timeline-write', () => ({
  writeTimelineActionRow: timeline.write,
}));

const layout = (staged: unknown[] = []) => ({
  version: 12,
  roles: [
    {
      id: FULL_A,
      zone: 'dc1',
      capacity: 16 * TB,
      tags: ['ssd', 'name:vault-01'],
    },
    { id: FULL_B, zone: 'dc2', capacity: null, tags: [] },
  ],
  parameters: { zoneRedundancy: 'maximum' },
  partitionSize: 1_000_000,
  stagedRoleChanges: staged,
  stagedParameters: null,
});

const status = {
  layoutVersion: 12,
  nodes: [
    { id: FULL_A, isUp: true, draining: false },
    { id: FULL_B, isUp: true, draining: false },
    // Connected, no role: the "add a node to the layout" case.
    { id: FULL_NEW, isUp: true, draining: false },
  ],
};

/** The fingerprint the page would have been served for an empty staging area. */
const EMPTY_FINGERPRINT = stagedFingerprint([]);

const post = (body: unknown) =>
  new Request('http://test/x', { method: 'POST', body: JSON.stringify(body) });

const assign = (overrides: Record<string, unknown> = {}) => ({
  expectedVersion: 12,
  expectedStagedFingerprint: EMPTY_FINGERPRINT,
  changes: [
    {
      action: 'assign',
      nodeId: KEY_A,
      zone: 'dc3',
      gateway: false,
      capacityBytes: 32 * TB,
      tags: ['ssd', 'name:vault-01'],
      ...overrides,
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  garage.getLayout.mockResolvedValue(layout());
  garage.getStatus.mockResolvedValue(status);
  garage.getReplicationFactor.mockResolvedValue(3);
  garage.updateLayout.mockImplementation(async () => layout());
  timeline.write.mockResolvedValue(true);
});

describe('POST /next-api/garage/cluster/staging — assign', () => {
  it('sends Garage the full node id and all three role fields', async () => {
    const { POST } = await import('./route');

    const res = await POST(post(assign()));

    expect(res.status).toBe(200);
    expect(garage.updateLayout).toHaveBeenCalledTimes(1);
    expect(garage.updateLayout).toHaveBeenCalledWith(expect.anything(), [
      {
        id: FULL_A,
        zone: 'dc3',
        capacity: 32 * TB,
        tags: ['ssd', 'name:vault-01'],
      },
    ]);
  });

  it('stages a gateway as capacity null', async () => {
    const { POST } = await import('./route');

    await POST(post(assign({ gateway: true, capacityBytes: null })));

    expect(garage.updateLayout).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ id: FULL_A, capacity: null }),
    ]);
  });

  it('accepts a node that has joined but has no role yet', async () => {
    const { POST } = await import('./route');

    const res = await POST(post(assign({ nodeId: KEY_NEW })));

    expect(res.status).toBe(200);
    expect(garage.updateLayout).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ id: FULL_NEW }),
    ]);
  });

  it('emits node keys and never a full id', async () => {
    const { POST } = await import('./route');
    garage.updateLayout.mockResolvedValue(
      layout([{ id: FULL_A, zone: 'dc3', capacity: 32 * TB, tags: ['ssd'] }])
    );

    const body = await (await POST(post(assign()))).json();

    expect(body.roles.map((r: { id: string }) => r.id)).toEqual([KEY_A, KEY_B]);
    expect(body.staged[0].id).toBe(KEY_A);
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{64}/i);
  });
});

describe('POST /next-api/garage/cluster/staging — remove', () => {
  it('sends a bare remove', async () => {
    const { POST } = await import('./route');

    const res = await POST(
      post({
        expectedVersion: 12,
        expectedStagedFingerprint: EMPTY_FINGERPRINT,
        changes: [{ action: 'remove', nodeId: KEY_B }],
      })
    );

    expect(res.status).toBe(200);
    expect(garage.updateLayout).toHaveBeenCalledWith(expect.anything(), [
      { id: FULL_B, remove: true },
    ]);
  });
});

describe('the conflict check', () => {
  it('refuses a stale layout version and does not call Garage', async () => {
    const { POST } = await import('./route');

    const res = await POST(post({ ...assign(), expectedVersion: 11 }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('version 12');
    expect(garage.updateLayout).not.toHaveBeenCalled();
  });

  it('refuses when someone else staged something first', async () => {
    garage.getLayout.mockResolvedValue(
      layout([{ id: FULL_B, zone: 'dc2', capacity: 8 * TB, tags: [] }])
    );
    const { POST } = await import('./route');

    const res = await POST(post(assign()));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('Someone else staged');
    expect(garage.updateLayout).not.toHaveBeenCalled();
  });

  it('accepts a matching fingerprint for a non-empty staging area', async () => {
    // Staging twice before applying is normal; only a *changed* staging area
    // is a conflict.
    const staged = [{ id: FULL_B, zone: 'dc2', capacity: 8 * TB, tags: [] }];
    garage.getLayout.mockResolvedValue(layout(staged));
    const { POST } = await import('./route');

    const res = await POST(
      post({
        ...assign(),
        expectedStagedFingerprint: stagedFingerprint([
          { id: KEY_B, zone: 'dc2', capacity: 8 * TB, tags: [] },
        ]),
      })
    );

    expect(res.status).toBe(200);
    expect(garage.updateLayout).toHaveBeenCalledTimes(1);
  });

  it('never retries — one refusal is one attempt', async () => {
    const { POST } = await import('./route');

    await POST(post({ ...assign(), expectedVersion: 11 }));

    expect(garage.updateLayout).toHaveBeenCalledTimes(0);
    expect(garage.getLayout).toHaveBeenCalledTimes(1);
  });
});

describe('the cluster timeline', () => {
  it('records the staged change against the node key', async () => {
    const { POST } = await import('./route');

    await POST(post(assign()));

    expect(timeline.write).toHaveBeenCalledTimes(1);
    expect(timeline.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'layout_staged',
        severity: 'info',
        category: 'maintenance',
        nodeId: KEY_A,
        actorId: 'u1',
      })
    );
    // The credential must not reach the timeline either.
    expect(JSON.stringify(timeline.write.mock.calls)).not.toMatch(
      /[0-9a-f]{64}/i
    );
  });

  it('carries the raw before and after values', async () => {
    const { POST } = await import('./route');

    await POST(post(assign()));

    expect(timeline.write).toHaveBeenCalledWith(
      expect.objectContaining({
        previousValue:
          'zone=dc1;capacity=16000000000000;tags=ssd,name:vault-01',
        newValue: 'zone=dc3;capacity=32000000000000;tags=ssd,name:vault-01',
      })
    );
  });

  it('records a refusal as a warning, and still fails the request', async () => {
    garage.updateLayout.mockRejectedValue(
      Object.assign(new Error('Garage said no'), { status: 502 })
    );
    const { POST } = await import('./route');

    const res = await POST(post(assign()));

    expect(res.status).toBe(502);
    expect(timeline.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'layout_staged',
        severity: 'warning',
        detail: expect.stringContaining('Garage said no'),
      })
    );
  });

  it('reports logged: false rather than failing when the row cannot be written', async () => {
    // The change is already staged on the cluster. Failing here would tell the
    // operator it was not, and they would stage it again.
    timeline.write.mockResolvedValue(false);
    const { POST } = await import('./route');

    const res = await POST(post(assign()));

    expect(res.status).toBe(200);
    expect((await res.json()).logged).toBe(false);
  });
});

describe('input validation', () => {
  const refuses = async (body: unknown, status = 400) => {
    const { POST } = await import('./route');
    const res = await POST(post(body));
    expect(res.status).toBe(status);
    expect(garage.updateLayout).not.toHaveBeenCalled();
  };

  it('refuses a capacity of 0 — that is the gateway switch', async () => {
    await refuses(assign({ capacityBytes: 0 }));
  });

  it('refuses a negative or fractional capacity', async () => {
    await refuses(assign({ capacityBytes: -1 }));
    vi.clearAllMocks();
    await refuses(assign({ capacityBytes: 1.5 }));
  });

  it('refuses a gateway that also declares capacity', async () => {
    await refuses(assign({ gateway: true }));
  });

  it('refuses a storage node with no capacity', async () => {
    await refuses(assign({ gateway: false, capacityBytes: null }));
  });

  it('refuses a zone that is empty or shaped like a flag', async () => {
    await refuses(assign({ zone: '' }));
    vi.clearAllMocks();
    await refuses(assign({ zone: '-g' }));
  });

  it('refuses a tag containing a comma or a space', async () => {
    await refuses(assign({ tags: ['a,b'] }));
    vi.clearAllMocks();
    await refuses(assign({ tags: ['two words'] }));
  });

  it('refuses a full node id — the browser speaks keys', async () => {
    await refuses(assign({ nodeId: FULL_A }));
  });

  it('refuses an empty change list', async () => {
    await refuses({
      expectedVersion: 12,
      expectedStagedFingerprint: EMPTY_FINGERPRINT,
      changes: [],
    });
  });

  it('404s a node Garage has never heard of, and says how to fix it', async () => {
    const { POST } = await import('./route');

    const res = await POST(post(assign({ nodeId: 'dddd000000000004' })));

    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('connect it to the cluster');
    expect(garage.updateLayout).not.toHaveBeenCalled();
  });
});

describe('GET /next-api/garage/cluster/staging', () => {
  it('serves the layout, the staging area and its fingerprint', async () => {
    garage.getLayout.mockResolvedValue(
      layout([
        { id: FULL_B, remove: true },
        { id: FULL_A, weirdness: 1 },
      ])
    );
    const { GET } = await import('./route');

    const body = await (await GET(new Request('http://test/x'))).json();

    expect(body.version).toBe(12);
    expect(body.staged).toEqual([{ id: KEY_B, remove: true }, { id: KEY_A }]);
    expect(body.stagedFingerprint).toBe(
      stagedFingerprint([{ id: KEY_B, remove: true }, { id: KEY_A }])
    );
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{64}/i);
  });

  it('offers connected nodes without a role as staging targets', async () => {
    const { GET } = await import('./route');

    const body = await (await GET(new Request('http://test/x'))).json();

    expect(body.candidates).toContainEqual(
      expect.objectContaining({ id: KEY_NEW, inLayout: false, isUp: true })
    );
    expect(body.candidates).toContainEqual(
      expect.objectContaining({ id: KEY_A, inLayout: true, name: 'vault-01' })
    );
  });

  it('reads live, never the stale-while-revalidate cache', async () => {
    // The version it serves is the one the conflict check is measured against.
    const { GET } = await import('./route');

    await GET(new Request('http://test/x'));

    expect(garage.getLayout).toHaveBeenCalledTimes(1);
  });

  it('flags staged parameters without serving them', async () => {
    garage.getLayout.mockResolvedValue({
      ...layout(),
      stagedParameters: { zoneRedundancy: { atLeast: 2 } },
    });
    const { GET } = await import('./route');

    const body = await (await GET(new Request('http://test/x'))).json();

    expect(body.stagedParametersPending).toBe(true);
    expect(JSON.stringify(body)).not.toContain('atLeast');
  });
});
