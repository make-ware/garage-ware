import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /next-api/garage/buckets/claim` behind FEATURE_ASSET_CLAIMS: the
 * refusal must land before any Garage call. The proof mechanics themselves are
 * covered by bucket-claim.test.ts; this file only pins the gate.
 */

const garage = vi.hoisted(() => ({
  getBucketInfo: vi.fn(),
  getLayout: vi.fn(),
}));
const pb = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@/lib/garage', () => ({
  GarageClient: { fromEnv: () => ({}) },
  buckets: { getBucketInfo: garage.getBucketInfo },
  cluster: { getLayout: garage.getLayout },
}));

vi.mock('@/lib/storage/live-keys', () => ({
  liveKeyIdsFor: async () => new Set<string>(),
}));

vi.mock('@/lib/storage/summary', () => ({
  getUserPosition: async () => ({
    netGrantedGb: 0,
    allocatedGb: 0,
    availableGb: 0,
  }),
}));

vi.mock('@garage-ware/shared/mutators', () => ({
  AccessKeyMutator: class {
    async listByUser() {
      return { items: [] };
    }
  },
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
    collection: () => ({ create: pb.create }),
  }),
}));

const post = (body: unknown) =>
  new Request('http://test/x', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /next-api/garage/buckets/claim', () => {
  it('403s with the feature off, without ever asking Garage', async () => {
    vi.stubEnv('FEATURE_ASSET_CLAIMS', '');
    const { POST } = await import('./route');

    const res = await POST(post({ garage_bucket_id: 'b1' }));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('disabled');
    expect(garage.getBucketInfo).not.toHaveBeenCalled();
    expect(pb.create).not.toHaveBeenCalled();
  });
});
