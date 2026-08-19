import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /next-api/garage/keys/claim` behind FEATURE_ASSET_CLAIMS.
 *
 * The refusal must land before any work: no body parse, no backoff, and above
 * all no Garage round trip — a dark feature must not stay usable as a
 * secret-checking oracle.
 */

const garage = vi.hoisted(() => ({
  verifyKeySecret: vi.fn(),
  getKeyInfo: vi.fn(),
}));
const pb = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@/lib/garage', () => ({
  GarageClient: { fromEnv: () => ({}) },
  keys: {
    verifyKeySecret: garage.verifyKeySecret,
    getKeyInfo: garage.getKeyInfo,
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
  garage.verifyKeySecret.mockResolvedValue(true);
  garage.getKeyInfo.mockResolvedValue({ accessKeyId: 'GK1', name: 'cli-key' });
  pb.create.mockResolvedValue({ id: 'k1', garage_key_id: 'GK1', name: 'k' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /next-api/garage/keys/claim', () => {
  it('403s with the feature off, without ever asking Garage', async () => {
    vi.stubEnv('FEATURE_ASSET_CLAIMS', '');
    const { POST } = await import('./route');

    const res = await POST(
      post({ access_key_id: 'GK1', secret_access_key: 's3cret' })
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('disabled');
    expect(garage.verifyKeySecret).not.toHaveBeenCalled();
    expect(pb.create).not.toHaveBeenCalled();
  });

  it('claims a key with the feature on and a correct secret', async () => {
    vi.stubEnv('FEATURE_ASSET_CLAIMS', 'true');
    const { POST } = await import('./route');

    const res = await POST(
      post({ access_key_id: 'GK1', secret_access_key: 's3cret' })
    );

    expect(res.status).toBe(200);
    expect(garage.verifyKeySecret).toHaveBeenCalled();
    expect(pb.create).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'u1', garage_key_id: 'GK1' })
    );
  });
});
