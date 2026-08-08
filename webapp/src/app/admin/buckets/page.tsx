'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { Button } from '@/components/ui/button';
import { ImportToUserDialog } from '@/components/admin/import-to-user-dialog';
import { QuotaFillPct } from '@/components/storage/quota-fill';
import { useTableSort } from '@/hooks/use-table-sort';
import { api } from '@/lib/api-client';
import { formatBytes, formatStorage } from '@/lib/format';
import { bytesToGib, gibToBytes } from '@/lib/storage/units';
import { toast } from 'sonner';
import type { BucketWithUsage } from '@/lib/types';
import type { UnallocatedBucket } from '@/app/next-api/garage/buckets/unallocated/route';

type AdminBucket = Omit<BucketWithUsage, 'expand'> & {
  expand?: { user?: { email?: string; name?: string } };
};

function ownerOf(b: AdminBucket): string {
  return b.expand?.user?.email ?? b.user;
}

/**
 * Module scope on purpose: `useTableSort` memoises on this reference, so an
 * inline object literal would be new every render and defeat the memo.
 */
const BUCKET_SORT = {
  name: (b: AdminBucket) => b.name,
  owner: ownerOf,
  size: (b: AdminBucket) => {
    const cap = gibToBytes(b.quota_gb ?? 0);
    return cap > 0 && b.bytes !== undefined ? (b.bytes / cap) * 100 : null;
  },
  objects: (b: AdminBucket) => {
    const cap = b.maxObjects ?? 0;
    return cap > 0 && b.objects !== undefined ? (b.objects / cap) * 100 : null;
  },
} as const;

type BucketSortKey = keyof typeof BUCKET_SORT;

export default function AdminBucketsPage() {
  const [buckets, setBuckets] = useState<AdminBucket[]>([]);
  const [unallocated, setUnallocated] = useState<UnallocatedBucket[]>([]);
  const [importing, setImporting] = useState<UnallocatedBucket | null>(null);

  // Fetch-only, so the mount effect and refresh() each own their setState.
  // They used to be verbatim copies where only one had a try/catch, which is
  // how a failing reload after a *successful* write reported as a failed write.
  const load = useCallback(async () => {
    const [all, free] = await Promise.all([
      api<{ items: AdminBucket[] }>('/next-api/garage/buckets?all=true'),
      api<{ items: UnallocatedBucket[] }>(
        '/next-api/garage/buckets/unallocated'
      ),
    ]);
    return { all, free };
  }, []);

  const refresh = useCallback(async () => {
    const { all, free } = await load();
    setBuckets(all.items);
    setUnallocated(free.items);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const { all, free } = await load();
        if (cancelled) return;
        setBuckets(all.items);
        setUnallocated(free.items);
      } catch (err) {
        if (!cancelled)
          toast.error(err instanceof Error ? err.message : 'Failed to load');
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function importBucket(garageBucketId: string, userId: string) {
    await api('/next-api/garage/buckets/import', {
      method: 'POST',
      body: { garage_bucket_id: garageBucketId, user_id: userId },
    });
    toast.success('Bucket imported');
    try {
      await refresh();
    } catch {
      toast.warning(
        'Imported, but the page could not reload — refresh to see it.'
      );
    }
  }

  const { sorted, sort, toggle } = useTableSort<AdminBucket, BucketSortKey>(
    buckets,
    BUCKET_SORT,
    { key: 'name', direction: 'asc' }
  );

  const totalQuotaGb = buckets.reduce((sum, b) => sum + (b.quota_gb ?? 0), 0);
  const totalBytes = buckets.reduce((sum, b) => sum + (b.bytes ?? 0), 0);
  const totalObjects = buckets.reduce((sum, b) => sum + (b.objects ?? 0), 0);

  return (
    <div className="p-8 max-w-7xl space-y-6">
      <h1 className="text-3xl font-bold">Buckets</h1>

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Buckets</CardDescription>
            <CardTitle>{buckets.length}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {unallocated.length > 0
              ? `${unallocated.length} unallocated`
              : 'all allocated'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total storage</CardDescription>
            <CardTitle>{formatBytes(totalBytes)}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            used of {formatStorage(totalQuotaGb)} allocated
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total objects</CardDescription>
            <CardTitle>{totalObjects.toLocaleString()}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            stored across all buckets
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Allocated</CardDescription>
            <CardTitle>{formatStorage(totalQuotaGb)}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            reserved by bucket quotas
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All buckets</CardTitle>
          <CardDescription>
            Click a column to sort. Quota drift and per-bucket quota changes
            live on the{' '}
            <Link href="/admin/quota" className="underline">
              Quota
            </Link>{' '}
            page.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                  active={sort.key === 'owner'}
                  direction={sort.direction}
                  onSort={() => toggle('owner')}
                >
                  Owner
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
                <TableHead>Garage ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((b) => {
                const quotaGb = b.quota_gb ?? 0;
                const quotaBytes = gibToBytes(quotaGb);
                const maxObjects = b.maxObjects ?? null;
                return (
                  <TableRow key={b.id}>
                    <TableCell className="font-medium">{b.name}</TableCell>
                    <TableCell>
                      {b.expand?.user?.email ?? b.user.slice(0, 8) + '…'}
                    </TableCell>
                    <TableCell>
                      {b.bytes === undefined ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        formatBytes(b.bytes)
                      )}
                      <span className="text-muted-foreground">
                        {' / '}
                        {quotaGb > 0 ? formatStorage(quotaGb) : 'none'}
                      </span>
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
                    <TableCell className="font-mono text-xs">
                      {b.garage_bucket_id}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Unallocated buckets</CardTitle>
          <CardDescription>
            {unallocated.length === 0
              ? 'No orphaned buckets in the cluster.'
              : `${unallocated.length} bucket${unallocated.length === 1 ? '' : 's'} in Garage with no PocketBase owner. Import to assign one to a user.`}
          </CardDescription>
        </CardHeader>
        {unallocated.length > 0 && (
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Aliases</TableHead>
                  <TableHead>Garage ID</TableHead>
                  <TableHead>Used</TableHead>
                  <TableHead>Garage quota</TableHead>
                  <TableHead className="text-right">Objects</TableHead>
                  <TableHead className="text-right">Object limit</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unallocated.map((b) => {
                  const usedGb = bytesToGib(b.bytes ?? 0);
                  const maxGb = b.maxSize ? bytesToGib(b.maxSize) : 0;
                  const maxObjects = b.maxObjects ?? null;
                  return (
                    <TableRow key={b.id}>
                      <TableCell>
                        {b.globalAliases.length > 0 ? (
                          b.globalAliases.join(', ')
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {b.id}
                      </TableCell>
                      <TableCell>
                        {b.bytes === undefined ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          formatStorage(usedGb)
                        )}
                      </TableCell>
                      <TableCell>
                        {b.maxSize ? (
                          formatStorage(maxGb)
                        ) : (
                          <span className="text-muted-foreground">none</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {b.objects === undefined ? (
                          '—'
                        ) : (
                          <>
                            {b.objects.toLocaleString()}
                            <QuotaFillPct used={b.objects} cap={maxObjects} />
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {maxObjects != null && maxObjects > 0 ? (
                          maxObjects.toLocaleString()
                        ) : (
                          <span className="text-muted-foreground">none</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setImporting(b)}
                        >
                          Import…
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        )}
      </Card>

      <ImportToUserDialog
        open={importing !== null}
        onOpenChange={(open) => {
          if (!open) setImporting(null);
        }}
        title={
          importing
            ? `Import bucket: ${importing.globalAliases[0] ?? importing.id}`
            : ''
        }
        description="Choose a user to take ownership. Quota is read live from Garage."
        confirmLabel="Import bucket"
        onConfirm={async (userId) => {
          if (!importing) return;
          await importBucket(importing.id, userId);
        }}
      />
    </div>
  );
}
