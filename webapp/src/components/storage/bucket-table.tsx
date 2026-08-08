'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { QuotaFillPct } from '@/components/storage/quota-fill';
import { useTableSort } from '@/hooks/use-table-sort';
import { formatBytes, formatStorage } from '@/lib/format';
import { gibToBytes } from '@/lib/storage/units';
import type { BucketWithUsage } from '@/lib/types';

/**
 * Module scope on purpose: `useTableSort` memoises on this reference, so an
 * inline object literal would be new every render and defeat the memo.
 *
 * The two quota columns sort by *fill percentage*, not by the absolute figure —
 * "which bucket is closest to its limit" is the question a quota column is
 * being asked, and a 4 TB bucket at 10% is not fuller than a 100 GB one at 95%.
 * A bucket with no cap has no fill, so it sorts as missing (last, both
 * directions) rather than as 0%.
 */
export const DASHBOARD_BUCKET_SORT = {
  name: (b: BucketWithUsage) => b.name,
  used: (b: BucketWithUsage) => b.bytes ?? null,
  size: (b: BucketWithUsage) => {
    const cap = gibToBytes(b.quota_gb ?? 0);
    return cap > 0 && b.bytes !== undefined ? (b.bytes / cap) * 100 : null;
  },
  objects: (b: BucketWithUsage) => {
    const cap = b.maxObjects ?? 0;
    return cap > 0 && b.objects !== undefined ? (b.objects / cap) * 100 : null;
  },
} as const;

export type DashboardBucketSortKey = keyof typeof DASHBOARD_BUCKET_SORT;

/**
 * The user-facing bucket table: the `/admin/buckets` layout minus the columns a
 * user has no use for (owner, Garage ID), with the same colour-coded fill
 * percentages and click-to-sort headers.
 */
export function BucketTable({
  buckets,
  emptyMessage = 'No buckets yet.',
}: {
  buckets: BucketWithUsage[];
  emptyMessage?: string;
}) {
  const router = useRouter();
  const { sorted, sort, toggle } = useTableSort<
    BucketWithUsage,
    DashboardBucketSortKey
  >(buckets, DASHBOARD_BUCKET_SORT, { key: 'name', direction: 'asc' });

  if (buckets.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead
            active={sort.key === 'name'}
            direction={sort.direction}
            onSort={() => toggle('name')}
          >
            Name
          </SortableTableHead>
          <SortableTableHead
            active={sort.key === 'used'}
            direction={sort.direction}
            onSort={() => toggle('used')}
          >
            Used
          </SortableTableHead>
          <SortableTableHead
            active={sort.key === 'size'}
            direction={sort.direction}
            onSort={() => toggle('size')}
          >
            Size quota
          </SortableTableHead>
          <SortableTableHead
            active={sort.key === 'objects'}
            direction={sort.direction}
            onSort={() => toggle('objects')}
          >
            Object quota
          </SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((b) => {
          const quotaGb = b.quota_gb ?? 0;
          const quotaBytes = gibToBytes(quotaGb);
          const maxObjects = b.maxObjects ?? null;
          return (
            <TableRow
              key={b.id}
              className="cursor-pointer"
              onClick={() => router.push(`/dashboard/buckets/${b.id}`)}
            >
              <TableCell className="font-medium">
                {/* A real link, so the row is reachable by keyboard and opens in
                    a new tab on middle-click; the row click is the convenience. */}
                <Link
                  href={`/dashboard/buckets/${b.id}`}
                  className="hover:underline"
                >
                  {b.name}
                </Link>
              </TableCell>
              <TableCell>
                {b.bytes === undefined ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  formatBytes(b.bytes)
                )}
              </TableCell>
              <TableCell>
                {quotaGb > 0 ? (
                  formatStorage(quotaGb)
                ) : (
                  <span className="text-muted-foreground">none</span>
                )}
                <QuotaFillPct used={b.bytes} cap={quotaBytes} />
              </TableCell>
              <TableCell>
                {b.objects === undefined ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  b.objects.toLocaleString()
                )}
                <span className="text-muted-foreground">
                  {' / '}
                  {maxObjects && maxObjects > 0
                    ? maxObjects.toLocaleString()
                    : 'none'}
                </span>
                <QuotaFillPct used={b.objects} cap={maxObjects} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
