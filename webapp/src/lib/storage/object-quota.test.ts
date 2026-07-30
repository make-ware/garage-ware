import { afterEach, describe, expect, it } from 'vitest';
import { avgObjectSizeBytes, maxObjectsForQuotaGib } from './object-quota';
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
});
