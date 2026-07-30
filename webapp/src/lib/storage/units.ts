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
