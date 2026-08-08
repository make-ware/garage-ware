import 'server-only';
import type { Bucket } from '@garage-ware/shared';
import type { GarageBucket } from '@/lib/garage/schemas';
import type { TypedPocketBase } from '@/lib/types';
import { effectiveMaxObjectsFor } from '@/lib/storage/object-quota';
import { bytesToGib, gibToBytes } from '@/lib/storage/units';

/** Byte tolerance absorbing GiB ↔ bytes rounding noise. */
const BYTE_EPSILON = 1;

/** A full comparison of what we think a bucket's quota is against Garage. */
export interface QuotaDrift {
  /** PocketBase's `quota_gb`, in bytes. */
  pbSizeBytes: number;
  /** Garage's `quotas.maxSize`. */
  garageSizeBytes: number;
  sizeDrifted: boolean;
  /** Garage's `quotas.maxObjects` (0 when uncapped). */
  garageMaxObjects: number;
  /**
   * What this bucket *should* be capped at: its persisted `object_quota`
   * override when set, otherwise what the byte quota derives under the current
   * GARAGE_AVG_OBJECT_SIZE_MB. Null still means "no cap expected" rather than
   * "expected zero".
   */
  expectedMaxObjects: number | null;
  /**
   * True when `expectedMaxObjects` came from an explicit override rather than
   * the derivation. Carried so the admin UI can label a cap "override" vs
   * "derived" without re-deriving it client-side.
   */
  objectQuotaOverridden: boolean;
  objectsDrifted: boolean;
  /** True if either side disagrees. */
  drifted: boolean;
}

/**
 * Compare a bucket's stored quota against the live Garage one, on both axes.
 *
 * The object-count axis is the one nothing checked before. Absent an override,
 * `maxObjects` is derived from the byte quota via GARAGE_AVG_OBJECT_SIZE_MB, so
 * changing that setting silently leaves every existing bucket on its old cap —
 * no read path recomputes it, and `quotaHasDrifted` never looked. Reporting it
 * is not the same as fixing it: an object cap is a live limit, so repairing it
 * stays an explicit admin action rather than a side effect of a page load.
 *
 * An explicit `object_quota` override is what the object axis is measured
 * against when one is set. Without that, an admin who deliberately capped a
 * bucket would see it reported as drifted forever and reverted by the next
 * bulk reconcile.
 */
export function describeQuotaDrift(
  pbRecord: Bucket,
  garageInfo: GarageBucket
): QuotaDrift {
  const pbSizeBytes = gibToBytes(pbRecord.quota_gb ?? 0);
  const garageSizeBytes = garageInfo.quotas?.maxSize ?? 0;
  const sizeDrifted = Math.abs(garageSizeBytes - pbSizeBytes) > BYTE_EPSILON;

  const garageMaxObjects = garageInfo.quotas?.maxObjects ?? 0;
  const objectQuotaOverridden = (pbRecord.object_quota ?? 0) > 0;
  const expectedMaxObjects = effectiveMaxObjectsFor(pbRecord);
  // With no override and no average configured we expect no cap at all, so a
  // cap that is already set is still a disagreement worth surfacing.
  const objectsDrifted = (expectedMaxObjects ?? 0) !== garageMaxObjects;

  return {
    pbSizeBytes,
    garageSizeBytes,
    sizeDrifted,
    garageMaxObjects,
    expectedMaxObjects,
    objectQuotaOverridden,
    objectsDrifted,
    drifted: sizeDrifted || objectsDrifted,
  };
}

/**
 * True when the byte-level difference exceeds 1. The 1-byte tolerance absorbs
 * floating-point noise from the GiB ↔ bytes round-trip (gibToBytes rounds to
 * the nearest integer, so a clean GiB value always round-trips to 0 diff).
 * Quotas of 0 / null are both treated as 0 bytes — no false positives.
 *
 * Size only, deliberately: this drives the automatic read-path self-heal, and
 * quietly rewriting a bucket's object cap behind the owner's back is not
 * something a page load should do. Use `describeQuotaDrift` to see both axes.
 */
export function quotaHasDrifted(
  pbRecord: Bucket,
  garageInfo: GarageBucket
): boolean {
  return describeQuotaDrift(pbRecord, garageInfo).sizeDrifted;
}

/** Writes the Garage quota back to PocketBase when drift is detected. */
export async function syncQuotaToPb(
  pb: TypedPocketBase,
  pbRecord: Bucket,
  garageInfo: GarageBucket
): Promise<void> {
  if (!quotaHasDrifted(pbRecord, garageInfo)) return;
  const garageGib = bytesToGib(garageInfo.quotas?.maxSize ?? 0);
  console.warn(
    `[quota-sync] drift on ${pbRecord.id}: pb=${pbRecord.quota_gb} GiB → ${garageGib} GiB`
  );
  await pb.collection('Buckets').update(pbRecord.id, { quota_gb: garageGib });
}

/** Fire-and-forget wrapper safe to call from GET handlers. Never throws. */
export function syncQuotaToPbBackground(
  pb: TypedPocketBase,
  pbRecord: Bucket,
  garageInfo: GarageBucket
): void {
  if (!quotaHasDrifted(pbRecord, garageInfo)) return;
  syncQuotaToPb(pb, pbRecord, garageInfo).catch((err) =>
    console.error('[quota-sync] write failed:', pbRecord.id, err)
  );
}

/**
 * Fire-and-forget cache write of the last-known Garage usage + quota snapshot
 * (bytes, object count, byte quota, object quota) plus a timestamp. Consumed by
 * the daily bucket-usage-alerts cron in pb_hooks/main.pb.js — the cron is
 * DB-only and relies on dashboard reads to keep this fresh. `max_size` mirrors
 * Garage's maxSize and `max_objects` its maxObjects (each 0 when no cap is set).
 */
export function syncUsageToPbBackground(
  pb: TypedPocketBase,
  pbRecord: Bucket,
  garageInfo: GarageBucket
): void {
  const bytes = garageInfo.bytes ?? 0;
  const objects = garageInfo.objects ?? 0;
  const maxSize = garageInfo.quotas?.maxSize ?? 0;
  const maxObjects = garageInfo.quotas?.maxObjects ?? 0;
  pb.collection('Buckets')
    .update(pbRecord.id, {
      bytes,
      objects,
      max_size: maxSize,
      max_objects: maxObjects,
      usage_updated_at: new Date().toISOString(),
    })
    .catch((err) =>
      console.error('[usage-sync] write failed:', pbRecord.id, err)
    );
}
