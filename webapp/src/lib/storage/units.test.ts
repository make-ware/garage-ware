import { describe, expect, it } from 'vitest';
import {
  bytesToGb,
  bytesToGib,
  bytesToTb,
  floorToDecimals,
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
  toFixedFloor,
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

describe('floorToDecimals / toFixedFloor', () => {
  it('rounds down rather than up', () => {
    // The bug this exists for: a node holding 18.66666 TB used to seed the
    // grant input with "18.6667", which is above the input's own max, so the
    // browser silently refused to submit the form.
    expect(floorToDecimals(18.666666666, 4)).toBe(18.6666);
    expect(toFixedFloor(18.666666666, 4)).toBe('18.6666');
    expect(toFixedFloor(18.666666666, 2)).toBe('18.66');
  });

  it('never returns more than it was given', () => {
    for (const v of [0, 0.00001, 1.99999, 18.666666666, 931.3225746, 4.35]) {
      expect(floorToDecimals(v, 4)).toBeLessThanOrEqual(v);
    }
  });

  it('snaps values that are only a float-noise hair below a step', () => {
    // 4.35 * 100 === 434.99999999999994; a plain floor would show "4.34".
    expect(toFixedFloor(4.35, 2)).toBe('4.35');
    expect(toFixedFloor(gibToTb(tbToGib(2.5)), 4)).toBe('2.5000');
  });

  it('is monotonic, so flooring a bound never crosses a floored value', () => {
    const free = 18.666666666;
    expect(floorToDecimals(free, 4)).toBeLessThanOrEqual(
      floorToDecimals(free, 4)
    );
    expect(floorToDecimals(free - 1, 4)).toBeLessThan(floorToDecimals(free, 4));
  });

  it('floors negatives toward -Infinity, widening a lower bound', () => {
    // minGib is passed through the same helper; a reclaim limit must not be
    // tightened by display rounding.
    expect(floorToDecimals(-3.00005, 4)).toBe(-3.0001);
  });

  it('passes non-finite values through', () => {
    expect(floorToDecimals(Number.NaN, 2)).toBeNaN();
    expect(floorToDecimals(Number.POSITIVE_INFINITY, 2)).toBe(
      Number.POSITIVE_INFINITY
    );
  });
});
