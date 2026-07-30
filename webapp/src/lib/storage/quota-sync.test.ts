import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bucket } from '@garage-ware/shared';
import type { GarageBucket } from '@/lib/garage/schemas';
import { gibToBytes } from './units';
import {
  quotaHasDrifted,
  syncQuotaToPb,
  syncUsageToPbBackground,
} from './quota-sync';

function makePbBucket(quota_gb: number): Bucket {
  return {
    id: 'pb-bucket-1',
    quota_gb,
    user: 'user-1',
    garage_bucket_id: 'garage-1',
    name: 'my-bucket',
    collectionId: '',
    collectionName: 'Buckets',
    expand: {},
    created: '',
    updated: '',
  };
}

function makeGarageInfo(maxSize: number | null): GarageBucket {
  return {
    id: 'garage-1',
    globalAliases: [],
    quotas: { maxSize, maxObjects: null },
  };
}

function makeMockPb(updateFn = vi.fn()) {
  return { collection: () => ({ update: updateFn }) } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('quotaHasDrifted', () => {
  it('returns false when both are 0 / null (unlimited)', () => {
    expect(quotaHasDrifted(makePbBucket(0), makeGarageInfo(null))).toBe(false);
  });

  it('returns false when PB and Garage agree on a round GiB value', () => {
    expect(
      quotaHasDrifted(makePbBucket(10), makeGarageInfo(gibToBytes(10)))
    ).toBe(false);
  });

  it('returns false when diff is exactly 1 byte (within epsilon)', () => {
    expect(
      quotaHasDrifted(makePbBucket(10), makeGarageInfo(gibToBytes(10) + 1))
    ).toBe(false);
  });

  it('returns true when diff is 2 bytes', () => {
    expect(
      quotaHasDrifted(makePbBucket(10), makeGarageInfo(gibToBytes(10) + 2))
    ).toBe(true);
  });

  it('returns true when PB is 0 but Garage has a real quota', () => {
    expect(
      quotaHasDrifted(makePbBucket(0), makeGarageInfo(gibToBytes(5)))
    ).toBe(true);
  });

  it('returns true when Garage quota changed from 10 GiB to 20 GiB', () => {
    expect(
      quotaHasDrifted(makePbBucket(10), makeGarageInfo(gibToBytes(20)))
    ).toBe(true);
  });
});

describe('syncQuotaToPb', () => {
  it('does not call update when quota has not drifted', async () => {
    const mockUpdate = vi.fn();
    await syncQuotaToPb(
      makeMockPb(mockUpdate),
      makePbBucket(10),
      makeGarageInfo(gibToBytes(10))
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('calls update with correct quota_gb when drift is detected', async () => {
    const mockUpdate = vi.fn().mockResolvedValue({});
    await syncQuotaToPb(
      makeMockPb(mockUpdate),
      makePbBucket(10),
      makeGarageInfo(gibToBytes(20))
    );
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockUpdate).toHaveBeenCalledWith('pb-bucket-1', { quota_gb: 20 });
  });

  it('converts Garage bytes back to GiB for the update payload', async () => {
    const mockUpdate = vi.fn().mockResolvedValue({});
    await syncQuotaToPb(
      makeMockPb(mockUpdate),
      makePbBucket(0),
      makeGarageInfo(gibToBytes(5))
    );
    const [, payload] = mockUpdate.mock.calls[0];
    expect(payload.quota_gb).toBeCloseTo(5, 5);
  });
});

describe('syncUsageToPbBackground', () => {
  it('caches bytes, objects, max_size, max_objects, and a timestamp', () => {
    const mockUpdate = vi.fn().mockResolvedValue({});
    const garageInfo: GarageBucket = {
      id: 'garage-1',
      globalAliases: [],
      bytes: 12_345,
      objects: 678,
      quotas: { maxSize: gibToBytes(10), maxObjects: 1000 },
    };
    syncUsageToPbBackground(
      makeMockPb(mockUpdate),
      makePbBucket(10),
      garageInfo
    );
    expect(mockUpdate).toHaveBeenCalledOnce();
    const [id, payload] = mockUpdate.mock.calls[0];
    expect(id).toBe('pb-bucket-1');
    expect(payload.bytes).toBe(12_345);
    expect(payload.objects).toBe(678);
    expect(payload.max_size).toBe(gibToBytes(10));
    expect(payload.max_objects).toBe(1000);
    expect(typeof payload.usage_updated_at).toBe('string');
  });

  it('defaults missing usage + quotas to 0 (no cap configured)', () => {
    const mockUpdate = vi.fn().mockResolvedValue({});
    syncUsageToPbBackground(
      makeMockPb(mockUpdate),
      makePbBucket(0),
      makeGarageInfo(null)
    );
    const [, payload] = mockUpdate.mock.calls[0];
    expect(payload.bytes).toBe(0);
    expect(payload.objects).toBe(0);
    expect(payload.max_size).toBe(0);
    expect(payload.max_objects).toBe(0);
  });
});
