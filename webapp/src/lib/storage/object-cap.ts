import { gibToBytes } from './units';

/**
 * Object-cap arithmetic, deliberately without `import 'server-only'`.
 *
 * This joins `units.ts` and `ledger-math.ts` as a `lib/storage` module the
 * browser needs: the admin quota dialog has to show the cap a bucket *would*
 * derive as the size input changes, and a second hand-rolled copy of the
 * formula inside a component is exactly how the two would come to disagree.
 * Only the arithmetic lives here — the `GARAGE_AVG_OBJECT_SIZE_MB` read stays
 * server-side in `object-quota.ts`, which injects the average into these.
 */

/**
 * Derive an object cap from a byte quota (stored as binary GiB) and an average
 * object size in bytes. Null means "no cap", which is what Garage's
 * `quotas.maxObjects` takes. A coarse accounting sanity-cap, not an exact
 * count — a non-zero quota always permits at least one object.
 */
export function deriveMaxObjects(
  quotaGib: number,
  avgBytes: number | null
): number | null {
  if (avgBytes === null || !(avgBytes > 0)) return null;
  if (!(quotaGib > 0)) return null;
  return Math.max(1, Math.floor(gibToBytes(quotaGib) / avgBytes));
}

/**
 * The cap a bucket should actually be under: the admin's persisted override
 * when one is set, otherwise the derivation.
 *
 * An `object_quota` of 0 / unset is "no override", **not** "cap at zero" —
 * Garage treats 0 and null as uncapped, so a deliberate zero is both
 * unexpressible and unwanted.
 */
export function effectiveMaxObjects(
  record: { quota_gb?: number; object_quota?: number },
  avgBytes: number | null
): number | null {
  const override = record.object_quota ?? 0;
  if (override > 0) return Math.floor(override);
  return deriveMaxObjects(record.quota_gb ?? 0, avgBytes);
}
