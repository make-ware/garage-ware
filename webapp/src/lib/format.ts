import {
  GIBIBYTE,
  GIGABYTE,
  KILOBYTE,
  MEGABYTE,
  PETABYTE,
  TERABYTE,
  toFixedFloor,
} from '@/lib/storage/units';

type FormatOpts = {
  decimals?: number;
  /**
   * `'floor'` (the default) never overstates; `'nearest'` is for observational
   * readings only — see {@link formatCapacity}.
   */
  round?: 'floor' | 'nearest';
};

/**
 * Format raw bytes with decimal (SI) units: B / KB / MB / GB / TB / PB.
 *
 * Rounds **down** by default, never up — see {@link toFixedFloor}. These
 * strings are read back and re-typed by admins granting capacity, so
 * overstating a figure by a rounding step produces a grant the server rejects.
 */
export function formatBytes(bytes: number, opts?: FormatOpts): string {
  const d = opts?.decimals ?? 2;
  // toFixed already rounds to nearest; toFixedFloor is the deliberate default.
  const fixed = (value: number) =>
    opts?.round === 'nearest' ? value.toFixed(d) : toFixedFloor(value, d);
  if (!Number.isFinite(bytes)) return `${bytes}`;
  const abs = Math.abs(bytes);
  if (abs >= PETABYTE)
    return `${stripTrailingZeros(fixed(bytes / PETABYTE))} PB`;
  if (abs >= TERABYTE)
    return `${stripTrailingZeros(fixed(bytes / TERABYTE))} TB`;
  if (abs >= GIGABYTE)
    return `${stripTrailingZeros(fixed(bytes / GIGABYTE))} GB`;
  if (abs >= MEGABYTE)
    return `${stripTrailingZeros(fixed(bytes / MEGABYTE))} MB`;
  if (abs >= KILOBYTE)
    return `${stripTrailingZeros(fixed(bytes / KILOBYTE))} KB`;
  return `${bytes} B`;
}

/**
 * Hardware capacity as the cluster screens show it: one decimal, rounded to
 * nearest.
 *
 * The cluster shows two figures for the same disk and they legitimately
 * disagree — "declared" is the capacity the operator wrote into the Garage
 * layout, "reported" is what the filesystem says it has. A 72 TB disk reports
 * 71.99 TB, and dividing a capacity by the replication factor rarely lands
 * anywhere round (55 TB at RF 3 is 18.3333…). At two floored decimals that
 * noise reads as a discrepancy worth chasing; at one rounded decimal both
 * figures say 72, which is what the operator means by a 72 TB disk.
 *
 * Deliberately **not** the default for {@link formatBytes}: rounding to
 * nearest can overstate by half a step, and every figure an admin might type
 * back into a grant — the claims table, the quota inputs, a user's balance —
 * must keep flooring. Nothing on the cluster map is typed anywhere; it is a
 * read of the hardware.
 */
export function formatCapacity(bytes: number): string {
  return formatBytes(bytes, { decimals: 1, round: 'nearest' });
}

/** {@link formatCapacity} for a value stored in binary GiB. */
export function formatCapacityGib(gib: number): string {
  return formatCapacity(gib * GIBIBYTE);
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

// ── Currency ─────────────────────────────────────────────────────────────
//
// Used by the dashboard cost card. Built at module scope, like `compactNumber`
// in dashboard/metrics/page.tsx — an Intl formatter is expensive to construct
// and these render once per comparison row.

const usdWhole = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const usdCents = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format a USD amount for display.
 *
 * Two honesty rules, both load-bearing for a card whose job is to be believed:
 *
 * 1. **A non-zero amount never renders as "$0.00".** At the cluster's amortized
 *    rate a small footprint genuinely costs fractions of a cent per month, and
 *    printing "$0.00" would be a claim that it is free. Anything above zero but
 *    below a cent renders "<$0.01"; only a true zero renders "$0.00".
 * 2. **Cents are dropped above $1,000.** "$12,847/yr" reads better than
 *    "$12,847.32/yr", and against a blended reference rate that precision is
 *    invented anyway. Below that the cents still carry information — a $389.50
 *    monthly line rounding to "$390" loses a figure the reader can check.
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0.00';
  const abs = Math.abs(usd);
  if (abs < 0.01) return usd < 0 ? '>-$0.01' : '<$0.01';
  return abs >= 1000 ? usdWhole.format(usd) : usdCents.format(usd);
}

/**
 * Render a "how many times dearer" multiple, e.g. "545×". `null` (an
 * unconfigured cluster rate, where the ratio is meaningless) renders as a dash
 * rather than "Infinity×".
 */
export function formatMultiple(multiple: number | null): string {
  if (multiple === null || !Number.isFinite(multiple) || multiple <= 0)
    return '—';
  if (multiple >= 100) return `${Math.round(multiple)}×`;
  if (multiple >= 10) return `${stripTrailingZeros(multiple.toFixed(1))}×`;
  return `${stripTrailingZeros(multiple.toFixed(2))}×`;
}
