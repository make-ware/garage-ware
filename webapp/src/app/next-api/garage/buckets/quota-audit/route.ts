import 'server-only';
import { GarageClient, buckets } from '@/lib/garage';
import { requireAdmin, errorResponse } from '@/lib/auth/server';
import { describeQuotaDrift } from '@/lib/storage/quota-sync';
import { bytesToGib } from '@/lib/storage/units';

export const dynamic = 'force-dynamic';

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
 */
export async function GET(req: Request) {
  try {
    const { pb } = await requireAdmin(req);
    const garage = GarageClient.fromEnv();

    const pbBuckets = await pb
      .collection('Buckets')
      .getFullList({ batch: 500 });

    const infos = await Promise.allSettled(
      pbBuckets.map((b) =>
        buckets.getBucketInfo(garage, { id: b.garage_bucket_id })
      )
    );

    let drifted = 0;
    let unknown = 0;

    const items = pbBuckets.map((record, i) => {
      const result = infos[i];
      const base = {
        id: record.id,
        name: record.name,
        user: record.user,
        garage_bucket_id: record.garage_bucket_id,
        pb_quota_gb: record.quota_gb ?? 0,
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
        garage_quota_gb: bytesToGib(drift.garageSizeBytes),
        size_drifted: drift.sizeDrifted,
        garage_max_objects: drift.garageMaxObjects,
        expected_max_objects: drift.expectedMaxObjects,
        objects_drifted: drift.objectsDrifted,
      };
    });

    return Response.json({
      items,
      total: items.length,
      drifted,
      unknown,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
