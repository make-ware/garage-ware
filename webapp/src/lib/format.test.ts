import { describe, expect, it } from 'vitest';
import { formatBytes, formatGib, formatStorage } from './format';
import { GIGABYTE, PETABYTE, TERABYTE, tbToGib } from './storage/units';

describe('formatBytes (decimal SI units)', () => {
  it('formats zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats GB at the GB boundary', () => {
    expect(formatBytes(GIGABYTE)).toBe('1 GB');
  });

  it('formats TB at the TB boundary', () => {
    expect(formatBytes(TERABYTE)).toBe('1 TB');
  });

  it('formats PB at the PB boundary', () => {
    expect(formatBytes(PETABYTE)).toBe('1 PB');
  });

  it('formats fractional TB', () => {
    expect(formatBytes(1.5 * TERABYTE)).toBe('1.5 TB');
  });

  it('strips trailing zeros', () => {
    expect(formatBytes(2 * GIGABYTE)).toBe('2 GB');
    expect(formatBytes(2.1 * GIGABYTE)).toBe('2.1 GB');
  });

  it('respects custom decimals', () => {
    expect(formatBytes(1.234_567 * TERABYTE, { decimals: 4 })).toBe(
      '1.2346 TB'
    );
  });

  it('falls back to MB / KB / B for sub-GB values', () => {
    expect(formatBytes(500_000)).toBe('500 KB');
    expect(formatBytes(2_500_000)).toBe('2.5 MB');
    expect(formatBytes(900)).toBe('900 B');
  });
});

describe('formatGib (binary GiB → decimal GB/TB)', () => {
  it('formats 0 GiB as 0 B', () => {
    expect(formatGib(0)).toBe('0 B');
  });

  it('formats ~931.32 GiB as 1 TB', () => {
    expect(formatGib(tbToGib(1))).toBe('1 TB');
  });

  it('formats 1024 GiB (=1 TiB) as 1.1 TB (decimal)', () => {
    // 1 TiB = 1.0995... TB
    expect(formatGib(1024)).toBe('1.1 TB');
  });

  it('formatStorage is the same as formatGib', () => {
    expect(formatStorage).toBe(formatGib);
    expect(formatStorage(tbToGib(2.5))).toBe('2.5 TB');
  });
});
