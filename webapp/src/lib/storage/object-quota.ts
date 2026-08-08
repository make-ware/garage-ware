import 'server-only';
import { MEGABYTE } from './units';
import { deriveMaxObjects, effectiveMaxObjects } from './object-cap';

/**
 * Average object size in bytes, derived from the optional
 * `GARAGE_AVG_OBJECT_SIZE_MB` env var (decimal MB). Returns null when the env is
 * unset or not a positive number — the signal that no object cap should be
 * applied. Read at request time (not module load) so it stays a plain runtime
 * env, configurable per deployment without a rebuild.
 */
export function avgObjectSizeBytes(): number | null {
  const raw = process.env.GARAGE_AVG_OBJECT_SIZE_MB;
  if (!raw) return null;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) return null;
  return mb * MEGABYTE;
}

/**
 * Derive a bucket's `maxObjects` quota from its byte quota alone, ignoring any
 * override. This is "what the configured average derives" — use it only where
 * there is no PocketBase record to consult (bucket creation), or where an
 * override has just been cleared.
 */
export function maxObjectsForQuotaGib(quotaGib: number): number | null {
  return deriveMaxObjects(quotaGib, avgObjectSizeBytes());
}

/**
 * What this bucket should actually be capped at: its persisted `object_quota`
 * override when set, otherwise the derivation. This is the one every write of a
 * `maxObjects` to Garage should go through, so an admin's deliberate cap is not
 * silently recomputed away.
 */
export function effectiveMaxObjectsFor(record: {
  quota_gb?: number;
  object_quota?: number;
}): number | null {
  return effectiveMaxObjects(record, avgObjectSizeBytes());
}
