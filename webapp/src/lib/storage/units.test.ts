import { describe, expect, it } from 'vitest';
import {
  bytesToGb,
  bytesToGib,
  bytesToTb,
  gbToBytes,
  gbToGib,
  gibToBytes,
  gibToGb,
  gibToTb,
  GIBIBYTE,
  GIGABYTE,
  PETABYTE,
  tbToBytes,
  tbToGib,
  TERABYTE,
} from './units';

describe('decimal byte conversions', () => {
  it('1 GB == 10^9 bytes', () => {
    expect(gbToBytes(1)).toBe(GIGABYTE);
    expect(bytesToGb(GIGABYTE)).toBe(1);
  });

  it('1 TB == 10^12 bytes', () => {
    expect(tbToBytes(1)).toBe(TERABYTE);
    expect(bytesToTb(TERABYTE)).toBe(1);
  });

  it('round-trips bytes <-> GB at non-trivial values', () => {
    const gb = 12.345;
    expect(bytesToGb(gbToBytes(gb))).toBeCloseTo(gb, 6);
  });

  it('rounds bytes to nearest integer', () => {
    expect(Number.isInteger(gbToBytes(1.000_000_001))).toBe(true);
    expect(Number.isInteger(tbToBytes(0.123_456))).toBe(true);
  });

  it('handles zero', () => {
    expect(gbToBytes(0)).toBe(0);
    expect(bytesToGb(0)).toBe(0);
    expect(tbToBytes(0)).toBe(0);
  });
});

describe('binary GiB <-> decimal bridges', () => {
  it('1 GiB ~= 1.073741824 GB', () => {
    expect(gibToGb(1)).toBeCloseTo(1.073_741_824, 9);
  });

  it('1 GB ~= 0.931322574 GiB', () => {
    expect(gbToGib(1)).toBeCloseTo(0.931_322_574_6, 9);
  });

  it('1 TB == GIBIBYTE-scaled equivalent of ~931.32 GiB', () => {
    expect(tbToGib(1)).toBeCloseTo(931.322_574_6, 6);
  });

  it('1 GiB == 1024^3 bytes / 10^12 TB', () => {
    expect(gibToTb(1)).toBeCloseTo(GIBIBYTE / TERABYTE, 12);
  });

  it('round-trips GiB -> GB -> GiB', () => {
    const samples = [0, 1, 100, 931.32, 1234.5678, 1_000_000];
    for (const gib of samples) {
      expect(gbToGib(gibToGb(gib))).toBeCloseTo(gib, 6);
    }
  });

  it('round-trips GiB -> TB -> GiB', () => {
    const samples = [0, 1, 100, 931.3225746, 12345.678];
    for (const gib of samples) {
      expect(tbToGib(gibToTb(gib))).toBeCloseTo(gib, 6);
    }
  });

  it('round-trips TB (UI) -> GiB (DB) -> TB (display)', () => {
    const samples = [0, 0.5, 1, 2.5, 10, 100];
    for (const tb of samples) {
      expect(gibToTb(tbToGib(tb))).toBeCloseTo(tb, 9);
    }
  });
});

describe('binary helpers (existing API)', () => {
  it('bytes <-> GiB are inverse', () => {
    expect(bytesToGib(GIBIBYTE)).toBe(1);
    expect(gibToBytes(1)).toBe(GIBIBYTE);
  });

  it('PETABYTE > TERABYTE > GIGABYTE', () => {
    expect(PETABYTE).toBeGreaterThan(TERABYTE);
    expect(TERABYTE).toBeGreaterThan(GIGABYTE);
  });
});
