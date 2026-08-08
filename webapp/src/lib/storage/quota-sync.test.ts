import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bucket } from '@garage-ware/shared';
import type { GarageBucket } from '@/lib/garage/schemas';
import { gibToBytes } from './units';
import {
  describeQuotaDrift,
  quotaHasDrifted,
  syncQuotaToPb,
  syncUsageToPbBackground,
} from './quota-sync';

const AVG_ENV = 'GARAGE_AVG_OBJECT_SIZE_MB';

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

function makeGarageInfo(
  maxSize: number | null,
  maxObjects: number | null = null
): GarageBucket {
  return {
    id: 'garage-1',
    globalAliases: [],
    quotas: { maxSize, maxObjects },
  };
}

function makeMockPb(updateFn = vi.fn()) {
  return { collection: () => ({ update: updateFn }) } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[AVG_ENV];
});

describe('describeQuotaDrift', () => {
  it('reports no drift when size matches and neither side caps objects', () => {
    const drift = describeQuotaDrift(
      makePbBucket(10),
      makeGarageInfo(gibToBytes(10))
    );
    expect(drift.sizeDrifted).toBe(false);
    expect(drift.objectsDrifted).toBe(false);
    expect(drift.drifted).toBe(false);
    expect(drift.expectedMaxObjects).toBeNull();
  });

  it('reports size drift with both sides in bytes', () => {
    const drift = describeQuotaDrift(
      makePbBucket(10),
      makeGarageInfo(gibToBytes(20))
    );
    expect(drift.sizeDrifted).toBe(true);
    expect(drift.pbSizeBytes).toBe(gibToBytes(10));
    expect(drift.garageSizeBytes).toBe(gibToBytes(20));
    expect(drift.drifted).toBe(true);
  });

  it('keeps the 1-byte tolerance for GiB round-tripping', () => {
    const drift = describeQuotaDrift(
      makePbBucket(10),
      makeGarageInfo(gibToBytes(10) + 1)
    );
    expect(drift.sizeDrifted).toBe(false);
  });

  it('reports object-cap drift even when the size agrees', () => {
    // The case nothing caught before: GARAGE_AVG_OBJECT_SIZE_MB changed, so
    // every existing bucket is left on an object cap that no longer derives
    // from its quota, and no read path recomputes it.
    process.env[AVG_ENV] = '1';
    const drift = describeQuotaDrift(
      makePbBucket(1),
      makeGarageInfo(gibToBytes(1), 500)
    );
    expect(drift.sizeDrifted).toBe(false);
    expect(drift.objectsDrifted).toBe(true);
    expect(drift.garageMaxObjects).toBe(500);
    expect(drift.expectedMaxObjects).toBe(1073);
    expect(drift.drifted).toBe(true);
  });

  it('reports no object drift when the cap already matches the derivation', () => {
    process.env[AVG_ENV] = '1';
    const expected = Math.floor(gibToBytes(1) / 1_000_000);
    const drift = describeQuotaDrift(
      makePbBucket(1),
      makeGarageInfo(gibToBytes(1), expected)
    );
    expect(drift.objectsDrifted).toBe(false);
    expect(drift.drifted).toBe(false);
  });

  it('treats a cap set with no average configured as drift', () => {
    // No average means "no cap expected", so a cap that is still set is a
    // leftover from a previous configuration.
    const drift = describeQuotaDrift(
      makePbBucket(1),
      makeGarageInfo(gibToBytes(1), 900)
    );
    expect(drift.expectedMaxObjects).toBeNull();
    expect(drift.objectsDrifted).toBe(true);
  });

  it('flags both axes at once', () => {
    process.env[AVG_ENV] = '1';
    const drift = describeQuotaDrift(
      makePbBucket(1),
      makeGarageInfo(gibToBytes(5), 12)
    );
    expect(drift.sizeDrifted).toBe(true);
    expect(drift.objectsDrifted).toBe(true);
  });
});

describe('quotaHasDrifted stays size-only', () => {
  it('ignores object-cap drift, so a page load never rewrites a live limit', () => {
    process.env[AVG_ENV] = '1';
    const pb = makePbBucket(1);
    const garage = makeGarageInfo(gibToBytes(1), 7);
    expect(describeQuotaDrift(pb, garage).objectsDrifted).toBe(true);
    expect(quotaHasDrifted(pb, garage)).toBe(false);
  });
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
