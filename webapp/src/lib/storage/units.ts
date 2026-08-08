// Binary (storage / Garage internals)
export const GIBIBYTE = 1024 ** 3;
export const TEBIBYTE = 1024 ** 4;
export const PEBIBYTE = 1024 ** 5;

// Decimal (display / consumer-facing)
export const KILOBYTE = 1_000;
export const MEGABYTE = 1_000 ** 2;
export const GIGABYTE = 1_000 ** 3;
export const TERABYTE = 1_000 ** 4;
export const PETABYTE = 1_000 ** 5;

/** Convert Garage API bytes to GiB — full float precision, no rounding */
export function bytesToGib(bytes: number): number {
  return bytes / GIBIBYTE;
}

/** Convert GiB (stored in PocketBase) to bytes for the Garage API — rounded to nearest integer */
export function gibToBytes(gib: number): number {
  return Math.round(gib * GIBIBYTE);
}

/** @deprecated Use `tbToGib` (decimal TB) for new UI code. */
export function tibToGib(tib: number): number {
  return tib * 1024;
}

/** @deprecated Use `gibToTb` (decimal TB) for new UI code. */
export function gibToTib(gib: number): number {
  return gib / 1024;
}

// ── Decimal conversions (UI ↔ bytes) ─────────────────────────────────────

export function bytesToGb(bytes: number): number {
  return bytes / GIGABYTE;
}

export function bytesToTb(bytes: number): number {
  return bytes / TERABYTE;
}

export function gbToBytes(gb: number): number {
  return Math.round(gb * GIGABYTE);
}

export function tbToBytes(tb: number): number {
  return Math.round(tb * TERABYTE);
}

// ── Bridges between UI (decimal) and DB (binary GiB) ─────────────────────

/** Convert binary GiB (PocketBase storage) to decimal GB for display. */
export function gibToGb(gib: number): number {
  return (gib * GIBIBYTE) / GIGABYTE;
}

/** Convert decimal GB (UI input) to binary GiB for storage. */
export function gbToGib(gb: number): number {
  return (gb * GIGABYTE) / GIBIBYTE;
}

/** Convert binary GiB (PocketBase storage) to decimal TB for display. */
export function gibToTb(gib: number): number {
  return (gib * GIBIBYTE) / TERABYTE;
}

/** Convert decimal TB (UI input) to binary GiB for storage. */
export function tbToGib(tb: number): number {
  return (tb * TERABYTE) / GIBIBYTE;
}

// ── Display rounding ─────────────────────────────────────────────────────

/**
 * Round `value` **down** to `decimals` places.
 *
 * Storage figures must never be displayed larger than they are. An admin who
 * reads "18.67 TB free" off a node holding 18.66666… TB and types it back is
 * asking for more than the node has — and the quota input seeds *itself* the
 * same way, so a rounded-up seed exceeds the input's own `max` attribute and
 * the browser blocks the submit before the request is ever sent. Flooring
 * makes every storage number the UI shows a number that can actually be
 * granted.
 *
 * The epsilon snap is not optional: scaling by a power of ten leaves round
 * figures a hair short (4.35 * 100 === 434.99999999999994), and a plain floor
 * would render an exact 4.35 TB claim as "4.34 TB". Only float noise is
 * snapped — a genuine 18.66666 stays floored.
 */
export function floorToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const nearest = Math.round(scaled);
  const tolerance = Math.abs(scaled) * 1e-12 + 1e-12;
  if (Math.abs(scaled - nearest) <= tolerance) return nearest / factor;
  return Math.floor(scaled) / factor;
}

/** {@link floorToDecimals}, rendered with a fixed number of places. */
export function toFixedFloor(value: number, decimals: number): string {
  return floorToDecimals(value, decimals).toFixed(decimals);
}
