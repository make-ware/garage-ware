import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /next-api/garage/buckets/claimable` — the ordering, which is the whole
 * point of the route's shape and the thing that regresses silently.
 *
 * `/dashboard/buckets` fires this on every load and refresh, and for almost
 * everybody the answer is empty forever: onboarding happens once. So the cheap,
 * shared, conclusive question — is there anything unclaimed in the cluster at
 * all — has to come before the per-key fan-out, or every page load pays one
 * `GetKeyInfo` per access key to be told nothing.
 */

const garage = vi.hoisted(() => ({
  listBuckets: vi.fn(),
  getBucketInfo: vi.fn(),
  getKeyInfo: vi.fn(),
  listKeys: vi.fn(),
}));
const pbRows = vi.hoisted(() => ({
  claimed: [] as { garage_bucket_id: string }[],
}));
const ownedKeys = vi.hoisted(() => ({
  items: [] as { garage_key_id: string }[],
}));

vi.mock('@/lib/garage', () => ({
  GarageClient: { fromEnv: () => ({}) },
  buckets: {
    listBuckets: garage.listBuckets,
    getBucketInfo: garage.getBucketInfo,
  },
  keys: { getKeyInfo: garage.getKeyInfo, listKeys: garage.listKeys },
}));

vi.mock('@/lib/storage/live-keys', () => ({
  // The real one calls ListKeys; here every key the caller holds is live unless
  // a test says otherwise.
  liveKeyIdsFor: async (_g: unknown, ids: string[]) => ids,
}));

vi.mock('@garage-ware/shared/mutators', () => ({
  AccessKeyMutator: class {
    async listByUser() {
      return ownedKeys;
    }
  },
}));

vi.mock('@/lib/auth/server', () => ({
  errorResponse: (err: { status?: number; message?: string }) =>
    Response.json({ error: err.message }, { status: err.status ?? 500 }),
  getServerUser: async () => ({ pb: {}, user: { id: 'u1' } }),
  getPbAsSuperuser: async () => ({
    collection: () => ({ getFullList: async () => pbRows.claimed }),
  }),
}));

const req = () => new Request('http://test/x');

const KEYED_BUCKET = {
  id: 'b-free',
  globalAliases: ['photos'],
  localAliases: [],
  permissions: { owner: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  ownedKeys.items = [{ garage_key_id: 'GK1' }];
  pbRows.claimed = [];
  garage.listBuckets.mockResolvedValue([{ id: 'b-free', globalAliases: [] }]);
  garage.getKeyInfo.mockResolvedValue({
    accessKeyId: 'GK1',
    buckets: [KEYED_BUCKET],
  });
  garage.getBucketInfo.mockResolvedValue({
    id: 'b-free',
    globalAliases: ['photos'],
    bytes: 10,
    objects: 2,
    quotas: { maxSize: 100 },
  });
});

describe('GET /next-api/garage/buckets/claimable', () => {
  it('does no per-key work when every bucket is already claimed', async () => {
    pbRows.claimed = [{ garage_bucket_id: 'b-free' }];
    const { GET } = await import('./route');

    const res = await GET(req());

    expect(await res.json()).toEqual({ items: [] });
    expect(garage.listBuckets).toHaveBeenCalledOnce();
    // The whole optimisation: the fan-out never runs in the steady state.
    expect(garage.getKeyInfo).not.toHaveBeenCalled();
    expect(garage.getBucketInfo).not.toHaveBeenCalled();
  });

  it('touches Garage not at all when the caller holds no keys', async () => {
    ownedKeys.items = [];
    const { GET } = await import('./route');

    expect(await (await GET(req())).json()).toEqual({ items: [] });
    expect(garage.listBuckets).not.toHaveBeenCalled();
  });

  it('offers an unclaimed bucket the caller owns, with its detail', async () => {
    const { GET } = await import('./route');

    const body = await (await GET(req())).json();

    expect(body.items).toEqual([
      {
        id: 'b-free',
        name: 'photos',
        bytes: 10,
        objects: 2,
        maxSize: 100,
        viaKeyId: 'GK1',
      },
    ]);
  });

  it('filters out a bucket somebody ELSE has claimed', async () => {
    // The superuser read is what makes this true: the caller's own client would
    // not see another user's row, and the bucket would only fail on click.
    pbRows.claimed = [{ garage_bucket_id: 'b-free' }];
    garage.listBuckets.mockResolvedValue([
      { id: 'b-free', globalAliases: [] },
      { id: 'b-other', globalAliases: [] },
    ]);
    const { GET } = await import('./route');

    const body = await (await GET(req())).json();

    // b-other is unclaimed but no key of the caller's owns it, so the gate
    // opens and the fan-out still finds nothing to offer.
    expect(body.items).toEqual([]);
    expect(garage.getKeyInfo).toHaveBeenCalledOnce();
    expect(garage.getBucketInfo).not.toHaveBeenCalled();
  });

  it('ignores a bucket the key only reads or writes', async () => {
    garage.getKeyInfo.mockResolvedValue({
      accessKeyId: 'GK1',
      buckets: [{ ...KEYED_BUCKET, permissions: { read: true, write: true } }],
    });
    const { GET } = await import('./route');

    expect((await (await GET(req())).json()).items).toEqual([]);
  });
});
