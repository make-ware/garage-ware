import { describe, expect, it } from 'vitest';
import { deriveMaxObjects, effectiveMaxObjects } from './object-cap';
import { MEGABYTE, gibToBytes } from './units';

// These are the browser-safe halves: the average is injected, never read from
// the environment, so there is nothing to stub here.

describe('deriveMaxObjects', () => {
  it('returns null with no average configured', () => {
    expect(deriveMaxObjects(100, null)).toBeNull();
  });

  it('returns null for a non-positive average', () => {
    expect(deriveMaxObjects(100, 0)).toBeNull();
    expect(deriveMaxObjects(100, -1)).toBeNull();
  });

  it('returns null for a zero quota', () => {
    expect(deriveMaxObjects(0, MEGABYTE)).toBeNull();
  });

  it('divides quota bytes by the average', () => {
    expect(deriveMaxObjects(1, MEGABYTE)).toBe(
      Math.floor(gibToBytes(1) / MEGABYTE)
    );
  });

  it('floors and always allows at least one object', () => {
    expect(deriveMaxObjects(0.000001, 1_000_000 * MEGABYTE)).toBe(1);
  });
});

describe('effectiveMaxObjects', () => {
  it('returns the override when set, even with no average configured', () => {
    expect(effectiveMaxObjects({ quota_gb: 10, object_quota: 500 }, null)).toBe(
      500
    );
  });

  it('lets the override beat a derivation that would differ', () => {
    // 1 GiB at a 1 MB average derives 1073; the override must win.
    expect(
      effectiveMaxObjects({ quota_gb: 1, object_quota: 500 }, MEGABYTE)
    ).toBe(500);
  });

  it('falls back to the derivation when the override is 0', () => {
    expect(
      effectiveMaxObjects({ quota_gb: 1, object_quota: 0 }, MEGABYTE)
    ).toBe(deriveMaxObjects(1, MEGABYTE));
  });

  it('falls back to the derivation when the override is absent', () => {
    expect(effectiveMaxObjects({ quota_gb: 1 }, MEGABYTE)).toBe(
      deriveMaxObjects(1, MEGABYTE)
    );
  });

  it('returns null with neither an override nor an average', () => {
    expect(effectiveMaxObjects({ quota_gb: 1 }, null)).toBeNull();
  });

  it('applies an override even when there is no size quota', () => {
    // Size-unlimited but object-capped is a coherent position, and the
    // derivation would refuse it.
    expect(
      effectiveMaxObjects({ quota_gb: 0, object_quota: 500 }, MEGABYTE)
    ).toBe(500);
  });

  it('floors a fractional override', () => {
    expect(effectiveMaxObjects({ quota_gb: 1, object_quota: 10.7 }, null)).toBe(
      10
    );
  });
});
