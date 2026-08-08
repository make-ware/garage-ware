import { afterEach, describe, expect, it } from 'vitest';
import {
  avgObjectSizeBytes,
  effectiveMaxObjectsFor,
  maxObjectsForQuotaGib,
} from './object-quota';
import { MEGABYTE, gibToBytes } from './units';

const ENV = 'GARAGE_AVG_OBJECT_SIZE_MB';

afterEach(() => {
  delete process.env[ENV];
});

describe('avgObjectSizeBytes', () => {
  it('returns null when unset', () => {
    expect(avgObjectSizeBytes()).toBeNull();
  });

  it('returns null for non-positive or non-numeric values', () => {
    for (const v of ['0', '-5', 'abc', '']) {
      process.env[ENV] = v;
      expect(avgObjectSizeBytes()).toBeNull();
    }
  });

  it('converts MB to bytes', () => {
    process.env[ENV] = '4';
    expect(avgObjectSizeBytes()).toBe(4 * MEGABYTE);
  });
});

describe('maxObjectsForQuotaGib', () => {
  it('returns null when env unset (no cap applied)', () => {
    expect(maxObjectsForQuotaGib(100)).toBeNull();
  });

  it('returns null for a zero quota', () => {
    process.env[ENV] = '4';
    expect(maxObjectsForQuotaGib(0)).toBeNull();
  });

  it('derives object count from quota bytes / avg object size', () => {
    process.env[ENV] = '1'; // 1 MB average
    // 1 GiB / 1 MB == GIBIBYTE / MEGABYTE objects
    expect(maxObjectsForQuotaGib(1)).toBe(Math.floor(gibToBytes(1) / MEGABYTE));
  });

  it('floors to a whole number and allows at least 1', () => {
    process.env[ENV] = '1000000'; // 1 TB average — larger than a tiny quota
    expect(maxObjectsForQuotaGib(0.000001)).toBe(1);
  });

  it('ignores an override — this is the derivation, not the effective cap', () => {
    process.env[ENV] = '1';
    expect(maxObjectsForQuotaGib(1)).toBe(Math.floor(gibToBytes(1) / MEGABYTE));
  });
});

describe('effectiveMaxObjectsFor', () => {
  it('returns the override even when no average is configured', () => {
    expect(effectiveMaxObjectsFor({ quota_gb: 10, object_quota: 500 })).toBe(
      500
    );
  });

  it('lets the override win over a differing derivation', () => {
    process.env[ENV] = '1';
    expect(effectiveMaxObjectsFor({ quota_gb: 1, object_quota: 500 })).toBe(
      500
    );
  });

  it('falls back to the derivation when the override is 0', () => {
    process.env[ENV] = '1';
    expect(effectiveMaxObjectsFor({ quota_gb: 1, object_quota: 0 })).toBe(
      maxObjectsForQuotaGib(1)
    );
  });

  it('falls back to the derivation when the override is absent', () => {
    process.env[ENV] = '1';
    expect(effectiveMaxObjectsFor({ quota_gb: 1 })).toBe(
      maxObjectsForQuotaGib(1)
    );
  });

  it('returns null with neither an override nor an average', () => {
    expect(effectiveMaxObjectsFor({ quota_gb: 1 })).toBeNull();
  });

  it('applies an override to a bucket with no size quota', () => {
    expect(effectiveMaxObjectsFor({ quota_gb: 0, object_quota: 500 })).toBe(
      500
    );
  });
});
