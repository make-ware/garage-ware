import 'server-only';
import { GarageClient, buckets } from '@/lib/garage';
import { requireAdmin, errorResponse } from '@/lib/auth/server';
import { describeQuotaDrift } from '@/lib/storage/quota-sync';
import { avgObjectSizeBytes } from '@/lib/storage/object-quota';
import { bytesToGib } from '@/lib/storage/units';

export const dynamic = 'force-dynamic';

/** One row of `GET /next-api/garage/buckets/quota-audit`. */
export interface QuotaAuditRow {
  id: string;
  name: string;
  user: string;
  /** Owner's email, expanded from PocketBase. Absent if the relation is gone. */
  user_email?: string;
  garage_bucket_id: string;
  /** PocketBase's size quota, binary GiB. */
  pb_quota_gb: number;
  /** PocketBase's object-cap override. 0 means "derive". */
  pb_object_quota: number;
  status: 'ok' | 'drifted' | 'unknown';
  error?: string;
  /** Live usage, already in hand from the Garage fetch. */
  bytes?: number;
  objects?: number;
  garage_quota_gb?: number;
  size_drifted?: boolean;
  garage_max_objects?: number;
  expected_max_objects?: number | null;
  /** True when `expected_max_objects` came from the override, not a derivation. */
  object_quota_overridden?: boolean;
  objects_drifted?: boolean;
}

export interface QuotaAuditResponse {
  items: QuotaAuditRow[];
  total: number;
  drifted: number;
  unknown: number;
  /**
   * `GARAGE_AVG_OBJECT_SIZE_MB` in bytes, or null when unset. Served so the
   * admin quota dialog can live-derive the default cap as the size input
   * changes. It rides on this admin-gated route rather than `/next-api/config`,
   * which is deliberately unauthenticated and scoped to the S3 browser.
   */
  avg_object_size_bytes: number | null;
}

/**
 * Compare every bucket's stored quota against the live Garage one.
 *
 * The two are written by separate calls in `PATCH /next-api/garage/buckets/[id]`
 * with no rollback between them, so a failure in the middle leaves them
 * disagreeing — and until now the only repair happened as a side effect of
 * someone loading a page. This is the view that makes the disagreement visible,
 * on both the size and object-count axes.
 *
 * A bucket whose Garage fetch fails is reported as `status: 'unknown'` rather
 * than as clean: not knowing is not the same as agreeing.
 *
 * Usage and owner email are returned alongside the drift verdict on purpose.
 * Both are already in hand here — `getBucketInfo` is fetched per bucket either
 * way — and the alternative, joining client-side against
 * `/next-api/garage/buckets?all=true`, would decorate this complete list with
 * that endpoint's single 200-row page and silently lose usage past row 200.
 */
export async function GET(req: Request) {
  try {
    const { pb } = await requireAdmin(req);
    const garage = GarageClient.fromEnv();

    const pbBuckets = await pb
      .collection('Buckets')
      .getFullList({ batch: 500, expand: 'user' });

    const infos = await Promise.allSettled(
      pbBuckets.map((b) =>
        buckets.getBucketInfo(garage, { id: b.garage_bucket_id })
      )
    );

    let drifted = 0;
    let unknown = 0;

    const items: QuotaAuditRow[] = pbBuckets.map((record, i) => {
      const result = infos[i];
      const expandedUser = (
        record as { expand?: { user?: { email?: string } } }
      ).expand?.user;
      const base = {
        id: record.id,
        name: record.name,
        user: record.user,
        ...(expandedUser?.email && { user_email: expandedUser.email }),
        garage_bucket_id: record.garage_bucket_id,
        pb_quota_gb: record.quota_gb ?? 0,
        pb_object_quota: record.object_quota ?? 0,
      };

      if (result.status === 'rejected') {
        unknown += 1;
        return {
          ...base,
          status: 'unknown' as const,
          error: String(result.reason),
        };
      }

      const drift = describeQuotaDrift(record, result.value);
      if (drift.drifted) drifted += 1;

      return {
        ...base,
        status: drift.drifted ? ('drifted' as const) : ('ok' as const),
        bytes: result.value.bytes ?? 0,
        objects: result.value.objects ?? 0,
        garage_quota_gb: bytesToGib(drift.garageSizeBytes),
        size_drifted: drift.sizeDrifted,
        garage_max_objects: drift.garageMaxObjects,
        expected_max_objects: drift.expectedMaxObjects,
        object_quota_overridden: drift.objectQuotaOverridden,
        objects_drifted: drift.objectsDrifted,
      };
    });

    const body: QuotaAuditResponse = {
      items,
      total: items.length,
      drifted,
      unknown,
      avg_object_size_bytes: avgObjectSizeBytes(),
    };
    return Response.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}
