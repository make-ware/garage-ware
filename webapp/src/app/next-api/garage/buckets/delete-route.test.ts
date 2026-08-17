import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `DELETE /next-api/garage/buckets/[id]`, end to end through the real handler.
 *
 * This route was a 500 that printed `deleteBucket is temporarily disabled while
 * testing` into a user's toast, and nothing tested it. The three cases below are
 * the whole contract: delete an empty bucket, refuse a full one with something
 * actionable, and treat a bucket Garage has already lost as deleted so the
 * PocketBase row can never be stranded.
 */

const RECORD = {
  id: 'pb-bucket-1',
  user: 'u1',
  garage_bucket_id: 'b1f4c1e9a2d8036f',
  name: 'photos',
  quota_gb: 10,
};

const garage = vi.hoisted(() => ({
  getBucketInfo: vi.fn(),
  deleteBucket: vi.fn(),
}));
const pb = vi.hoisted(() => ({ deleteRow: vi.fn() }));

class FakeNotFound extends Error {}

vi.mock('@/lib/garage', () => ({
  GarageClient: { fromEnv: () => ({}) },
  GarageNotFoundError: FakeNotFound,
  buckets: garage,
  cluster: { getLayout: vi.fn() },
}));

vi.mock('@/lib/auth/ownership', () => ({
  loadOwnedBucket: async () => ({ record: RECORD }),
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
  getPbAsSuperuser: async () => ({
    collection: () => ({ delete: pb.deleteRow }),
  }),
}));

vi.mock('@/lib/storage/quota-sync', () => ({
  syncQuotaToPbBackground: vi.fn(),
  syncUsageToPbBackground: vi.fn(),
}));

const req = () => new Request('http://test/x', { method: 'DELETE' });
const ctx = { params: Promise.resolve({ id: 'pb-bucket-1' }) };

const EMPTY = {
  objects: 0,
  bytes: 0,
  unfinishedUploads: 0,
  unfinishedMultipartUploads: 0,
};

beforeEach(() => vi.clearAllMocks());

describe('DELETE /next-api/garage/buckets/[id]', () => {
  it('deletes an empty bucket, Garage first then PocketBase', async () => {
    garage.getBucketInfo.mockResolvedValue(EMPTY);
    garage.deleteBucket.mockResolvedValue(undefined);
    const { DELETE } = await import('./[id]/route');

    const res = await DELETE(req(), ctx);

    expect(res.status).toBe(200);
    expect(garage.deleteBucket).toHaveBeenCalledWith(
      {},
      RECORD.garage_bucket_id
    );
    expect(pb.deleteRow).toHaveBeenCalledWith(RECORD.id);
  });

  it('refuses a non-empty bucket with 409 and names what is in it', async () => {
    garage.getBucketInfo.mockResolvedValue({
      ...EMPTY,
      objects: 82431,
      bytes: 1_400_000_000_000,
    });
    const { DELETE } = await import('./[id]/route');

    const res = await DELETE(req(), ctx);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain('82,431 object');
    expect(body.error).toContain('Connect page');
    // Nothing was touched on either side.
    expect(garage.deleteBucket).not.toHaveBeenCalled();
    expect(pb.deleteRow).not.toHaveBeenCalled();
  });

  it('refuses when Garage will not say what the bucket holds', async () => {
    garage.getBucketInfo.mockResolvedValue({ objects: 0 });
    const { DELETE } = await import('./[id]/route');

    const res = await DELETE(req(), ctx);

    expect(res.status).toBe(409);
    expect(garage.deleteBucket).not.toHaveBeenCalled();
  });

  it('still clears the PocketBase row when Garage no longer has the bucket', async () => {
    // The stranded-row case. Without this the pre-flight 404 would abort before
    // the PocketBase delete and the row could never be removed — it would go on
    // reserving allocated_gb and feeding the daily alert cron forever.
    garage.getBucketInfo.mockRejectedValue(new FakeNotFound('gone'));
    garage.deleteBucket.mockResolvedValue(undefined);
    const { DELETE } = await import('./[id]/route');

    const res = await DELETE(req(), ctx);

    expect(res.status).toBe(200);
    expect(pb.deleteRow).toHaveBeenCalledWith(RECORD.id);
  });
});
