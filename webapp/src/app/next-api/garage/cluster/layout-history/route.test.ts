import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /next-api/garage/cluster/layout-history` — counts out, node identity
 * never.
 *
 * `GetClusterLayoutHistory` also returns `updateTrackers`, a map **keyed by
 * full node id**. Two gates keep it out: the schema does not describe it (so it
 * is dropped at the parse), and this route projects field by field. The test
 * feeds a response that has it anyway, which is what a schema regression would
 * look like.
 */

const FULL = 'a'.repeat(64);

const garage = vi.hoisted(() => ({ getLayoutHistory: vi.fn() }));

vi.mock('@/lib/garage', () => ({
  GarageClient: { fromEnv: () => ({}) },
  cluster: garage,
}));

vi.mock('@/lib/auth/server', () => ({
  HttpError: class extends Error {},
  errorResponse: (err: { status?: number; message?: string }) =>
    Response.json({ error: err.message }, { status: err.status ?? 500 }),
  requireAdmin: async () => ({ pb: {}, user: { id: 'u1' } }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  garage.getLayoutHistory.mockResolvedValue({
    currentVersion: 12,
    minAck: 11,
    versions: [
      { version: 12, status: 'Current', storageNodes: 3, gatewayNodes: 1 },
      { version: 11, status: 'Draining', storageNodes: 2, gatewayNodes: 1 },
    ],
    updateTrackers: { [FULL]: { ack: 12, sync: 12, syncAck: 12 } },
  });
});

describe('GET /next-api/garage/cluster/layout-history', () => {
  it('serves the versions and the acknowledged floor', async () => {
    const { GET } = await import('./route');

    const body = await (await GET(new Request('http://test/x'))).json();

    expect(body.currentVersion).toBe(12);
    expect(body.minAck).toBe(11);
    expect(body.versions).toEqual([
      { version: 12, status: 'Current', storageNodes: 3, gatewayNodes: 1 },
      { version: 11, status: 'Draining', storageNodes: 2, gatewayNodes: 1 },
    ]);
  });

  it('never emits updateTrackers, or any full node id', async () => {
    const { GET } = await import('./route');

    const raw = JSON.stringify(
      await (await GET(new Request('http://test/x'))).json()
    );

    expect(raw).not.toContain('updateTrackers');
    expect(raw).not.toMatch(/[0-9a-f]{64}/i);
  });
});
