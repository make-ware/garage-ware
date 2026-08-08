'use client';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { fillPct } from '@/components/storage/quota-fill';
import { formatBytes, formatStorage } from '@/lib/format';
import { gibToBytes } from '@/lib/storage/units';
import { cn } from '@/lib/utils';
import type { BucketWithUsage } from '@/lib/types';

/**
 * The four high-level tiles from `/admin/buckets`, scoped to one user.
 *
 * `allocatedGb` and `grantedGb` are passed in rather than summed here on
 * purpose: the authoritative figures come from `getUserStorageSummary` behind
 * `/next-api/garage/storage-summary` (which accounts for transfers and
 * decommissioned nodes), and a second sum over `quota_gb` in a component is
 * exactly how the two would come to disagree. Only the per-bucket usage
 * readings — bytes and object counts, which have no server-side roll-up — are
 * totalled here.
 */
export function BucketMetrics({
  buckets,
  allocatedGb,
  grantedGb,
  className,
}: {
  buckets: BucketWithUsage[];
  allocatedGb: number;
  grantedGb: number;
  className?: string;
}) {
  const totalBytes = buckets.reduce((sum, b) => sum + (b.bytes ?? 0), 0);
  const totalObjects = buckets.reduce((sum, b) => sum + (b.objects ?? 0), 0);
  const freeGb = Math.max(grantedGb - allocatedGb, 0);

  // A bucket counts as near-full on whichever axis is worse — an object cap can
  // stop writes just as hard as a byte cap, and only one of them has to be hit.
  const nearFull = buckets.filter((b) => {
    const sizeFill = fillPct(b.bytes, gibToBytes(b.quota_gb ?? 0));
    const objectFill = fillPct(b.objects, b.maxObjects);
    return (sizeFill ?? 0) >= 90 || (objectFill ?? 0) >= 90;
  }).length;

  return (
    <div className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-4', className)}>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Buckets</CardDescription>
          <CardTitle>{buckets.length}</CardTitle>
        </CardHeader>
        <CardContent
          className={cn(
            'text-sm',
            nearFull > 0 ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {buckets.length === 0
            ? 'none yet'
            : nearFull > 0
              ? `${nearFull} over 90% full`
              : 'none over 90% full'}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Storage used</CardDescription>
          <CardTitle>{formatBytes(totalBytes)}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          used of {formatStorage(allocatedGb)} allocated
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Objects</CardDescription>
          <CardTitle>{totalObjects.toLocaleString()}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          stored across all buckets
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Allocated</CardDescription>
          <CardTitle>{formatStorage(allocatedGb)}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          of {formatStorage(grantedGb)} granted — {formatStorage(freeGb)} free
        </CardContent>
      </Card>
    </div>
  );
}
