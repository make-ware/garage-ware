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

/**
 * Render a signed ledger amount, e.g. "+2 TB" / "-500 GB".
 * Ledger entries are signed adjustments, so the sign is the point — never let
 * a negative render as a bare magnitude.
 */
export function formatSignedStorage(gib: number, opts?: FormatOpts): string {
  return `${gib < 0 ? '-' : '+'}${formatGib(Math.abs(gib), opts)}`;
}

/**
 * Format a PocketBase timestamp as a short local date.
 *
 * PocketBase serialises datetimes as "YYYY-MM-DD HH:mm:ss.sssZ" with a space
 * rather than a "T", which Safari and some other engines refuse to parse.
 * Swapping in the "T" first is what makes this safe to use everywhere.
 */
export function formatPbDate(value: string | undefined | null): string {
  if (!value) return '—';
  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Same parsing fix as {@link formatPbDate}, but including the time of day. */
export function formatPbDateTime(value: string | undefined | null): string {
  if (!value) return '—';
  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function stripTrailingZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}
