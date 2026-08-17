import 'server-only';
import type { Bucket } from '@garage-ware/shared';
import { GarageClient, buckets } from '@/lib/garage';
import { getCachedLayout } from '@/lib/garage/cached';
import type { GarageBucket } from '@/lib/garage/schemas';
import { getPbAsSuperuser } from '@/lib/auth/server';
import type { TypedPocketBase } from '@/lib/types';
import { allocatedExcluding } from '@/lib/storage/ledger-math';
import { getUserPosition } from '@/lib/storage/summary';
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

/**
 * What a `syncQuotaToPb` call actually did.
 *
 * It exists because the refusal below is silent by design on the read path and
 * must **not** be silent on the write path: `POST /buckets/reconcile` is an
 * admin explicitly asking for the drift to be repaired, and reporting a
 * `synced` for a bucket it declined to touch tells them a job is done that the
 * drift page will contradict on the very next render.
 */
export type QuotaSyncOutcome =
  | { status: 'written'; quotaGb: number }
  /** Nothing to do — the two sides already agree. */
  | { status: 'unchanged' }
  /** Drift left in place on purpose. `reason` is safe to show an admin. */
  | { status: 'refused'; reason: string };

/**
 * Writes the Garage quota back to PocketBase when drift is detected.
 *
 * **It refuses to adopt a quota that would over-allocate the owner.** This is
 * the only path in the app that raises `quota_gb` — and therefore
 * `allocated_gb`, via the Buckets update hook — without a human asking for it:
 * it runs from `refreshBucketsFromGarageBackground` on every dashboard load. So
 * raising `maxSize` out of band, or claiming a bucket whose Garage quota does
 * not fit the claimer's grant, would otherwise breach
 * `sum(bucket.quota_gb) <= netGranted` from a page view, silently, with no
 * request to reject. Every foreground path checks that invariant; a background
 * task must not be the one exception.
 *
 * When it refuses, it leaves the disagreement in place rather than papering
 * over it — that is precisely what `/admin/quota` exists to show, and an admin
 * can then either grant capacity or push PocketBase's value back to Garage.
 *
 * The layout read is **cached**: this is a self-heal on a display path, and
 * blocking a page load on Garage to decide whether to rewrite a number is a
 * worse trade than deciding it against a layout a minute old. A claim or a
 * quota edit — the paths where being a minute stale would actually let capacity
 * be over-committed — reads live.
 */
export async function syncQuotaToPb(
  pb: TypedPocketBase,
  pbRecord: Bucket,
  garageInfo: GarageBucket
): Promise<QuotaSyncOutcome> {
  if (!quotaHasDrifted(pbRecord, garageInfo)) return { status: 'unchanged' };
  const garageGib = bytesToGib(garageInfo.quotas?.maxSize ?? 0);

  if (garageGib > (pbRecord.quota_gb ?? 0)) {
    const { fits, reason } = await adoptionFitsOwner(pbRecord, garageGib);
    if (!fits) {
      console.warn(
        `[quota-sync] refusing drift adoption on ${pbRecord.id}: ${reason}; left as drift for /admin/quota`
      );
      return { status: 'refused', reason };
    }
  }

  console.warn(
    `[quota-sync] drift on ${pbRecord.id}: pb=${pbRecord.quota_gb} GiB → ${garageGib} GiB`
  );
  // Superuser: Buckets' write rules are null since
  // 1787600000_lock_asset_write_rules.js.
  const writePb = await getPbAsSuperuser();
  await writePb.collection('Buckets').update(pbRecord.id, {
    quota_gb: garageGib,
  });
  return { status: 'written', quotaGb: garageGib };
}

/**
 * Would raising this bucket to `nextGb` keep its owner within their grant?
 *
 * Fails **closed** — an unreadable position means "do not adopt", because the
 * cost of skipping a legitimate self-heal is a row on the drift page, and the
 * cost of adopting a bad one is a broken invariant nothing will catch.
 *
 * The two refusals are told apart in `reason` rather than collapsed into a
 * bare `false`: "this would over-allocate the owner" is a decision an admin can
 * act on, and "we could not tell" is a fault they need to know about, and the
 * reconcile route surfaces whichever it was.
 *
 * The position is read from the **materialized balances** in one query, through
 * the same `computeSummaryFromBalances` every other reader uses. It deliberately
 * does not call `BucketMutator.sumAllocatedGb`: that reads a single page of a
 * collection that only grows, and nothing in the accounting path may use it.
 */
async function adoptionFitsOwner(
  pbRecord: Bucket,
  nextGb: number
): Promise<{ fits: boolean; reason: string }> {
  try {
    const pb = await getPbAsSuperuser();
    const layout = await getCachedLayout();
    const position = await getUserPosition(pb, pbRecord.user, layout);
    const granted = position.netGrantedGb;
    const allocatedElsewhere = allocatedExcluding(
      position.allocatedGb,
      pbRecord.quota_gb
    );
    if (allocatedElsewhere + nextGb <= granted)
      return { fits: true, reason: '' };
    return {
      fits: false,
      reason: `adopting ${nextGb} GiB would over-allocate the owner (${allocatedElsewhere} GiB already allocated elsewhere of ${granted} GiB granted)`,
    };
  } catch (err) {
    console.error('[quota-sync] could not check owner position:', err);
    return {
      fits: false,
      reason: "the owner's storage position could not be read",
    };
  }
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
  // Superuser: Buckets' write rules are null. The `pb` parameter stays on the
  // signature because callers pass their own client and the read side of this
  // module still uses it; only the write escalates.
  void getPbAsSuperuser()
    .then((writePb) =>
      writePb.collection('Buckets').update(pbRecord.id, {
        bytes,
        objects,
        max_size: maxSize,
        max_objects: maxObjects,
        usage_updated_at: new Date().toISOString(),
      })
    )
    .catch((err) =>
      console.error('[usage-sync] write failed:', pbRecord.id, err)
    );
}

/**
 * Refresh the usage cache for a set of buckets off the response path.
 *
 * `GET /next-api/garage/buckets` used to await one `GetBucketInfo` per bucket
 * before it could answer, then write the results into the cache columns it was
 * not reading. Serving the columns and refreshing them behind the response
 * gives the same freshness — the next load sees this pass — without the wait.
 *
 * Deliberately ungated by any TTL. The daily `bucket-usage-alerts` cron is
 * DB-only and relies on dashboard reads to keep these columns current, so
 * every GET still refreshes; only the waiting went away. The size-drift
 * self-heal (`syncQuotaToPbBackground`) moves here with it — the same write it
 * always made, now off the critical path.
 *
 * Never throws, and never rejects: a bucket Garage cannot answer for is logged
 * and skipped, leaving its cached row as the last thing we knew.
 */
export function refreshBucketsFromGarageBackground(
  pb: TypedPocketBase,
  items: readonly Bucket[]
): void {
  if (items.length === 0) return;

  void (async () => {
    const garage = GarageClient.fromEnv();
    const settled = await Promise.allSettled(
      items.map((b) =>
        buckets.getBucketInfo(garage, { id: b.garage_bucket_id })
      )
    );
    items.forEach((item, i) => {
      const result = settled[i];
      if (result.status !== 'fulfilled') {
        console.error(
          '[usage-sync] refresh failed:',
          item.garage_bucket_id,
          result.reason
        );
        return;
      }
      syncQuotaToPbBackground(pb, item, result.value);
      syncUsageToPbBackground(pb, item, result.value);
    });
  })().catch((err) => console.error('[usage-sync] refresh pass failed:', err));
}
