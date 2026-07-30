import 'server-only';
import { MEGABYTE, gibToBytes } from './units';

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
 * Derive a bucket's `maxObjects` quota from its byte quota (stored as binary
 * GiB) and the configured average object size. Returns null when no average is
 * configured or the quota is 0, so callers can hand the result straight to
 * Garage's `quotas.maxObjects` (null = no cap). This is a coarse accounting
 * sanity-cap, not an exact count — at least 1 object is always allowed for a
 * non-zero quota.
 */
export function maxObjectsForQuotaGib(quotaGib: number): number | null {
  const avg = avgObjectSizeBytes();
  if (avg === null) return null;
  if (!(quotaGib > 0)) return null;
  return Math.max(1, Math.floor(gibToBytes(quotaGib) / avg));
}
