import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /next-api/garage/repairs/node-stats` — three integers per node, and the
 * two omissions that are the point of the route.
 */

const KEY_A = 'aaaa000000000001';
const FULL_A = KEY_A + '0123456789abcdef'.repeat(3);
const KEY_B = 'bbbb000000000002';
const FULL_B = KEY_B + '0123456789abcdef'.repeat(3);

const garage = vi.hoisted(() => ({ getNodeStatistics: vi.fn() }));

vi.mock('@/lib/garage', () => ({
  GarageClient: { fromEnv: () => ({}) },
  cluster: garage,
}));

vi.mock('@/lib/auth/server', () => ({
  HttpError: class extends Error {},
  errorResponse: (err: { message?: string }) =>
    Response.json({ error: err.message }, { status: 500 }),
  requireAdmin: async () => ({ pb: {}, user: { id: 'u1' } }),
}));

const req = () => new Request('http://test/next-api/garage/repairs/node-stats');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /next-api/garage/repairs/node-stats', () => {
  it('maps the three counters and keys the node ids', async () => {
    garage.getNodeStatistics.mockResolvedValue([
      {
        nodeId: FULL_A,
        ok: true,
        value: {
          freeform: 'Garage version: v2.3.0\nDatabase engine: LMDB',
          blockManagerStats: {
            rcEntries: 900,
            resyncQueueLen: 26_541,
            resyncErrors: 3,
          },
          tableStats: [],
        },
      },
    ]);

    const { GET } = await import('./route');
    const body = await (await GET(req())).json();

    expect(body.items[0]).toMatchObject({
      nodeId: KEY_A,
      error: null,
      resyncQueueLen: 26_541,
      resyncErrors: 3,
      rcEntries: 900,
    });
    expect(body.fetchedAt).toBeTruthy();
  });

  it('never carries freeform or tableStats to the browser', async () => {
    // The spec says not to parse `freeform`. Shipping it is how a second prose
    // parser gets written — the opposite of what /repairs/workers does, and
    // deliberately so.
    garage.getNodeStatistics.mockResolvedValue([
      {
        nodeId: FULL_A,
        ok: true,
        value: {
          freeform: 'Garage version: v2.3.0',
          blockManagerStats: {
            rcEntries: 1,
            resyncQueueLen: 2,
            resyncErrors: 0,
          },
          tableStats: [
            {
              tableName: 'block_ref',
              items: 1,
              merkleItems: 1,
              merkleQueueLen: 0,
              insertQueueLen: 0,
              gcQueueLen: 0,
            },
          ],
        },
      },
    ]);

    const { GET } = await import('./route');
    const raw = JSON.stringify(await (await GET(req())).json());

    expect(raw).not.toContain('freeform');
    expect(raw).not.toContain('tableStats');
    expect(raw).not.toContain('block_ref');
  });

  it('leaves an unreported block manager as null, never zero', async () => {
    garage.getNodeStatistics.mockResolvedValue([
      {
        nodeId: FULL_A,
        ok: true,
        value: { freeform: 'x', blockManagerStats: null, tableStats: null },
      },
    ]);

    const { GET } = await import('./route');
    const body = await (await GET(req())).json();

    // "Not reported" and "the queue is empty" are opposite conclusions, and a
    // page that renders 0 for the first has told the operator something false.
    expect(body.items[0].resyncQueueLen).toBeNull();
    expect(body.items[0].resyncErrors).toBeNull();
    expect(body.items[0].rcEntries).toBeNull();
  });

  it('carries a per-node error at 200', async () => {
    garage.getNodeStatistics.mockResolvedValue([
      { nodeId: FULL_A, ok: false, error: 'unreachable' },
      {
        nodeId: FULL_B,
        ok: true,
        value: {
          freeform: 'x',
          blockManagerStats: {
            rcEntries: 0,
            resyncQueueLen: 0,
            resyncErrors: 0,
          },
        },
      },
    ]);

    const { GET } = await import('./route');
    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    const failed = body.items.find(
      (i: { nodeId: string }) => i.nodeId === KEY_A
    );
    expect(failed.error).toBe('unreachable');
    expect(failed.resyncQueueLen).toBeNull();
  });
});
