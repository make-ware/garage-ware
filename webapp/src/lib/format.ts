import {
  GIBIBYTE,
  GIGABYTE,
  KILOBYTE,
  MEGABYTE,
  PETABYTE,
  TERABYTE,
} from '@/lib/storage/units';

type FormatOpts = { decimals?: number };

/** Format raw bytes with decimal (SI) units: B / KB / MB / GB / TB / PB. */
export function formatBytes(bytes: number, opts?: FormatOpts): string {
  const d = opts?.decimals ?? 2;
  if (!Number.isFinite(bytes)) return `${bytes}`;
  const abs = Math.abs(bytes);
  if (abs >= PETABYTE)
    return `${stripTrailingZeros((bytes / PETABYTE).toFixed(d))} PB`;
  if (abs >= TERABYTE)
    return `${stripTrailingZeros((bytes / TERABYTE).toFixed(d))} TB`;
  if (abs >= GIGABYTE)
    return `${stripTrailingZeros((bytes / GIGABYTE).toFixed(d))} GB`;
  if (abs >= MEGABYTE)
    return `${stripTrailingZeros((bytes / MEGABYTE).toFixed(d))} MB`;
  if (abs >= KILOBYTE)
    return `${stripTrailingZeros((bytes / KILOBYTE).toFixed(d))} KB`;
  return `${bytes} B`;
}

/** Format a value stored in binary GiB as a decimal GB / TB / PB string. */
export function formatGib(gib: number, opts?: FormatOpts): string {
  return formatBytes(gib * GIBIBYTE, opts);
}

/**
 * Backwards-compatible alias for callers that pass GiB.
 * Output is now true decimal GB/TB/PB (was previously binary mislabeled).
 */
export const formatStorage = formatGib;

function stripTrailingZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}
