import 'server-only';
import type { Bucket } from '@garage-ware/shared';
import type { GarageBucket } from '@/lib/garage/schemas';
import type { TypedPocketBase } from '@/lib/types';
import { bytesToGib, gibToBytes } from '@/lib/storage/units';

/**
 * True when the byte-level difference exceeds 1. The 1-byte tolerance absorbs
 * floating-point noise from the GiB ↔ bytes round-trip (gibToBytes rounds to
 * the nearest integer, so a clean GiB value always round-trips to 0 diff).
 * Quotas of 0 / null are both treated as 0 bytes — no false positives.
 */
export function quotaHasDrifted(
  pbRecord: Bucket,
  garageInfo: GarageBucket
): boolean {
  const garageBytes = garageInfo.quotas?.maxSize ?? 0;
  const pbBytes = gibToBytes(pbRecord.quota_gb ?? 0);
  return Math.abs(garageBytes - pbBytes) > 1;
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
