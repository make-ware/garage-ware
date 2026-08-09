import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bucket } from '@garage-ware/shared';
import type { GarageBucket } from '@/lib/garage/schemas';
import { gibToBytes } from './units';
import {
  describeQuotaDrift,
  quotaHasDrifted,
  refreshBucketsFromGarageBackground,
  syncQuotaToPb,
  syncUsageToPbBackground,
} from './quota-sync';

// Hoisted so the factory below can close over it: vi.mock runs before the
// module body, and a plain `const` would still be in its temporal dead zone.
const garageMock = vi.hoisted(() => ({ getBucketInfo: vi.fn() }));

vi.mock('@/lib/garage', () => ({
  GarageClient: { fromEnv: () => ({}) },
  buckets: { getBucketInfo: garageMock.getBucketInfo },
}));

const AVG_ENV = 'GARAGE_AVG_OBJECT_SIZE_MB';

function makePbBucket(quota_gb: number, object_quota?: number): Bucket {
  return {
    id: 'pb-bucket-1',
    quota_gb,
    object_quota,
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

  it('does not flag an override Garage already enforces', () => {
    // The case the override field exists for: a deliberate cap must stop
    // reading as drift, or every bulk reconcile would revert it.
    const drift = describeQuotaDrift(
      makePbBucket(1, 500),
      makeGarageInfo(gibToBytes(1), 500)
    );
    expect(drift.objectsDrifted).toBe(false);
    expect(drift.objectQuotaOverridden).toBe(true);
    expect(drift.expectedMaxObjects).toBe(500);
    expect(drift.drifted).toBe(false);
  });

  it('measures against the override, not the derivation', () => {
    process.env[AVG_ENV] = '1'; // 1 GiB would otherwise derive 1073
    const drift = describeQuotaDrift(
      makePbBucket(1, 500),
      makeGarageInfo(gibToBytes(1), 1073)
    );
    expect(drift.expectedMaxObjects).toBe(500);
    expect(drift.objectsDrifted).toBe(true);
    expect(drift.objectQuotaOverridden).toBe(true);
  });

  it('treats an object_quota of 0 as "derive", not "cap at zero"', () => {
    process.env[AVG_ENV] = '1';
    const expected = Math.floor(gibToBytes(1) / 1_000_000);
    const drift = describeQuotaDrift(
      makePbBucket(1, 0),
      makeGarageInfo(gibToBytes(1), expected)
    );
    expect(drift.objectQuotaOverridden).toBe(false);
    expect(drift.expectedMaxObjects).toBe(expected);
    expect(drift.objectsDrifted).toBe(false);
  });

  it('expects a cap from an override even with no size quota', () => {
    const drift = describeQuotaDrift(
      makePbBucket(0, 500),
      makeGarageInfo(0, 0)
    );
    expect(drift.sizeDrifted).toBe(false);
    expect(drift.expectedMaxObjects).toBe(500);
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

  it('ignores a drifted override too', () => {
    // A GET must never rewrite a live limit — override or not.
    const pb = makePbBucket(1, 500);
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

/**
 * `GET /buckets` now answers from the cached columns and refreshes them behind
 * the response, so this pass has to be genuinely fire-and-forget: it must never
 * reject, and one bucket Garage cannot answer for must not cost the others
 * their refresh.
 */
describe('refreshBucketsFromGarageBackground', () => {
  function bucketNamed(id: string): Bucket {
    return { ...makePbBucket(10), id, garage_bucket_id: `garage-${id}` };
  }

  beforeEach(() => {
    garageMock.getBucketInfo.mockReset();
  });

  it('does nothing at all for an empty list', () => {
    refreshBucketsFromGarageBackground(makeMockPb(), []);
    expect(garageMock.getBucketInfo).not.toHaveBeenCalled();
  });

  it('writes the usage cache for every bucket it can read', async () => {
    const mockUpdate = vi.fn().mockResolvedValue({});
    garageMock.getBucketInfo.mockImplementation(
      async (_garage: unknown, { id }: { id: string }) => ({
        id,
        globalAliases: [],
        bytes: 42,
        objects: 7,
        quotas: { maxSize: gibToBytes(10), maxObjects: 0 },
      })
    );

    refreshBucketsFromGarageBackground(makeMockPb(mockUpdate), [
      bucketNamed('a'),
      bucketNamed('b'),
    ]);

    await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2));
    expect(mockUpdate.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b']);
    const [, payload] = mockUpdate.mock.calls[0];
    expect(payload.bytes).toBe(42);
    expect(payload.objects).toBe(7);
    expect(typeof payload.usage_updated_at).toBe('string');
  });

  it('heals size drift on the same pass, off the response path', async () => {
    // The read-path self-heal that used to run before the response. Same write,
    // later moment: a quota update as well as the usage snapshot.
    const mockUpdate = vi.fn().mockResolvedValue({});
    garageMock.getBucketInfo.mockResolvedValue({
      id: 'garage-a',
      globalAliases: [],
      quotas: { maxSize: gibToBytes(20), maxObjects: null },
    });

    refreshBucketsFromGarageBackground(makeMockPb(mockUpdate), [
      bucketNamed('a'),
    ]);

    await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2));
    const payloads = mockUpdate.mock.calls.map(([, p]) => p);
    expect(payloads).toContainEqual({ quota_gb: 20 });
  });

  it('skips a bucket Garage cannot answer for, and still refreshes the rest', async () => {
    const mockUpdate = vi.fn().mockResolvedValue({});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    garageMock.getBucketInfo.mockImplementation(
      async (_garage: unknown, { id }: { id: string }) => {
        if (id === 'garage-a') throw new Error('quorum unavailable');
        return {
          id,
          globalAliases: [],
          bytes: 1,
          objects: 1,
          quotas: { maxSize: gibToBytes(10), maxObjects: 0 },
        };
      }
    );

    refreshBucketsFromGarageBackground(makeMockPb(mockUpdate), [
      bucketNamed('a'),
      bucketNamed('b'),
    ]);

    await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mock.calls[0][0]).toBe('b');
    expect(errors).toHaveBeenCalled();
  });
});
