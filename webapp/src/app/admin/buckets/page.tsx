'use client';

import { useEffect, useState } from 'react';
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
import { Button } from '@/components/ui/button';
import { ImportToUserDialog } from '@/components/admin/import-to-user-dialog';
import { api } from '@/lib/api-client';
import { formatStorage } from '@/lib/format';
import { bytesToGib } from '@/lib/storage/units';
import { toast } from 'sonner';
import type { BucketWithUsage } from '@/lib/types';
import type { UnallocatedBucket } from '@/app/next-api/garage/buckets/unallocated/route';

type AdminBucket = Omit<BucketWithUsage, 'expand'> & {
  expand?: { user?: { email?: string; name?: string } };
};

export default function AdminBucketsPage() {
  const [buckets, setBuckets] = useState<AdminBucket[]>([]);
  const [unallocated, setUnallocated] = useState<UnallocatedBucket[]>([]);
  const [importing, setImporting] = useState<UnallocatedBucket | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [all, free] = await Promise.all([
          api<{ items: AdminBucket[] }>('/next-api/garage/buckets?all=true'),
          api<{ items: UnallocatedBucket[] }>(
            '/next-api/garage/buckets/unallocated'
          ),
        ]);
        if (cancelled) return;
        setBuckets(all.items);
        setUnallocated(free.items);
      } catch (err) {
        if (!cancelled)
          toast.error(err instanceof Error ? err.message : 'Failed to load');
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    const [all, free] = await Promise.all([
      api<{ items: AdminBucket[] }>('/next-api/garage/buckets?all=true'),
      api<{ items: UnallocatedBucket[] }>(
        '/next-api/garage/buckets/unallocated'
      ),
    ]);
    setBuckets(all.items);
    setUnallocated(free.items);
  }

  async function importBucket(garageBucketId: string, userId: string) {
    await api('/next-api/garage/buckets/import', {
      method: 'POST',
      body: { garage_bucket_id: garageBucketId, user_id: userId },
    });
    toast.success('Bucket imported');
    await refresh();
  }

  const totalQuotaGb = buckets.reduce((sum, b) => sum + (b.quota_gb ?? 0), 0);
  const totalUsedGb = bytesToGib(
    buckets.reduce((sum, b) => sum + (b.bytes ?? 0), 0)
  );
  const totalObjects = buckets.reduce((sum, b) => sum + (b.objects ?? 0), 0);

  return (
    <div className="p-8 max-w-6xl space-y-6">
      <h1 className="text-3xl font-bold">Buckets</h1>
      <Card>
        <CardHeader>
          <CardTitle>All buckets</CardTitle>
          <CardDescription>
            {buckets.length} total · {formatStorage(totalUsedGb)} used of{' '}
            {formatStorage(totalQuotaGb)} allocated ·{' '}
            {totalObjects.toLocaleString()} objects.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Used</TableHead>
                <TableHead>Quota</TableHead>
                <TableHead className="text-right">Objects</TableHead>
                <TableHead className="text-right">Object limit</TableHead>
                <TableHead>Garage ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {buckets.map((b) => {
                const usedGb = bytesToGib(b.bytes ?? 0);
                const quotaGb = b.quota_gb ?? 0;
                const pct =
                  quotaGb > 0 ? Math.round((usedGb / quotaGb) * 100) : null;
                const maxObjects = b.maxObjects ?? null;
                const objPct =
                  maxObjects && maxObjects > 0 && b.objects !== undefined
                    ? Math.round(((b.objects ?? 0) / maxObjects) * 100)
                    : null;
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
                        <>
                          {formatStorage(usedGb)}
                          {pct !== null && (
                            <span className="text-muted-foreground text-xs ml-1">
                              ({pct}%)
                            </span>
                          )}
                        </>
                      )}
                    </TableCell>
                    <TableCell>{formatStorage(quotaGb)}</TableCell>
                    <TableCell className="text-right">
                      {b.objects === undefined ? (
                        '—'
                      ) : (
                        <>
                          {(b.objects ?? 0).toLocaleString()}
                          {objPct !== null && (
                            <span className="text-muted-foreground text-xs ml-1">
                              ({objPct}%)
                            </span>
                          )}
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
                  const objPct =
                    maxObjects && maxObjects > 0 && b.objects !== undefined
                      ? Math.round((b.objects / maxObjects) * 100)
                      : null;
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
                            {objPct !== null && (
                              <span className="text-muted-foreground text-xs ml-1">
                                ({objPct}%)
                              </span>
                            )}
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
