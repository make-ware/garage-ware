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
import { Badge } from '@/components/ui/badge';
import { ImportToUserDialog } from '@/components/admin/import-to-user-dialog';
import { SetBucketQuotaDialog } from '@/components/admin/set-bucket-quota-dialog';
import { api } from '@/lib/api-client';
import { formatStorage } from '@/lib/format';
import { bytesToGib } from '@/lib/storage/units';
import { toast } from 'sonner';
import type { AdminUser } from '@/lib/admin-types';
import type { BucketWithUsage } from '@/lib/types';
import type { UnallocatedBucket } from '@/app/next-api/garage/buckets/unallocated/route';

type AdminBucket = Omit<BucketWithUsage, 'expand'> & {
  expand?: { user?: { email?: string; name?: string } };
};

/** One row of GET /next-api/garage/buckets/quota-audit. */
interface QuotaAuditRow {
  id: string;
  name: string;
  user: string;
  pb_quota_gb: number;
  status: 'ok' | 'drifted' | 'unknown';
  error?: string;
  garage_quota_gb?: number;
  size_drifted?: boolean;
  garage_max_objects?: number;
  expected_max_objects?: number | null;
  objects_drifted?: boolean;
}

interface QuotaAuditResponse {
  items: QuotaAuditRow[];
  total: number;
  drifted: number;
  unknown: number;
}

interface QuotaTarget {
  bucket: AdminBucket;
  audit?: QuotaAuditRow;
}

export default function AdminBucketsPage() {
  const [buckets, setBuckets] = useState<AdminBucket[]>([]);
  const [unallocated, setUnallocated] = useState<UnallocatedBucket[]>([]);
  const [audit, setAudit] = useState<QuotaAuditResponse | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [importing, setImporting] = useState<UnallocatedBucket | null>(null);
  const [quotaTarget, setQuotaTarget] = useState<QuotaTarget | null>(null);
  const [reconciling, setReconciling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [all, free, auditResp, usersResp] = await Promise.all([
          api<{ items: AdminBucket[] }>('/next-api/garage/buckets?all=true'),
          api<{ items: UnallocatedBucket[] }>(
            '/next-api/garage/buckets/unallocated'
          ),
          api<QuotaAuditResponse>('/next-api/garage/buckets/quota-audit'),
          api<{ items: AdminUser[] }>('/next-api/garage/users'),
        ]);
        if (cancelled) return;
        setBuckets(all.items);
        setUnallocated(free.items);
        setAudit(auditResp);
        setUsers(usersResp.items);
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
    const [all, free, auditResp, usersResp] = await Promise.all([
      api<{ items: AdminBucket[] }>('/next-api/garage/buckets?all=true'),
      api<{ items: UnallocatedBucket[] }>(
        '/next-api/garage/buckets/unallocated'
      ),
      api<QuotaAuditResponse>('/next-api/garage/buckets/quota-audit'),
      api<{ items: AdminUser[] }>('/next-api/garage/users'),
    ]);
    setBuckets(all.items);
    setUnallocated(free.items);
    setAudit(auditResp);
    setUsers(usersResp.items);
  }

  async function reconcile(
    direction: 'adopt-garage' | 'push-pb',
    bucketIds?: string[]
  ) {
    setReconciling(true);
    try {
      const result = await api<{ synced: number; failed: number }>(
        '/next-api/garage/buckets/reconcile',
        {
          method: 'POST',
          body: {
            direction,
            includeObjects: true,
            ...(bucketIds && { bucketIds }),
          },
        }
      );
      const verb =
        direction === 'adopt-garage'
          ? 'adopted from Garage'
          : 'pushed to Garage';
      toast.success(
        `${result.synced} bucket${result.synced === 1 ? '' : 's'} ${verb}` +
          (result.failed > 0 ? ` · ${result.failed} failed` : '')
      );
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reconcile failed');
    } finally {
      setReconciling(false);
    }
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

  const auditById = new Map((audit?.items ?? []).map((a) => [a.id, a]));
  const userById = new Map(users.map((u) => [u.id, u]));
  const driftedIds = (audit?.items ?? [])
    .filter((a) => a.status === 'drifted')
    .map((a) => a.id);

  return (
    <div className="p-8 max-w-7xl space-y-6">
      <h1 className="text-3xl font-bold">Buckets</h1>

      {audit && audit.drifted > 0 && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-base">Quota drift detected</CardTitle>
            <CardDescription>
              {audit.drifted} bucket{audit.drifted === 1 ? '' : 's'} where what
              we record disagrees with what Garage enforces
              {audit.unknown > 0 && ` · ${audit.unknown} could not be checked`}.
              Adopting takes Garage as the truth; pushing re-applies our value,
              which is what repairs a quota change that only half landed.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={reconciling}
              onClick={() => reconcile('adopt-garage', driftedIds)}
            >
              Adopt Garage values
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={reconciling}
              onClick={() => reconcile('push-pb', driftedIds)}
            >
              Push our values to Garage
            </Button>
          </CardContent>
        </Card>
      )}

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
                <TableHead>Drift</TableHead>
                <TableHead className="text-right">Objects</TableHead>
                <TableHead className="text-right">Object limit</TableHead>
                <TableHead>Garage ID</TableHead>
                <TableHead className="w-24" />
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
                const drift = auditById.get(b.id);
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
                    <TableCell className="text-xs">
                      {!drift || drift.status === 'ok' ? (
                        <span className="text-muted-foreground">—</span>
                      ) : drift.status === 'unknown' ? (
                        <Badge
                          variant="outline"
                          title={drift.error ?? 'Garage did not answer'}
                        >
                          unknown
                        </Badge>
                      ) : (
                        <div className="space-y-0.5">
                          {drift.size_drifted && (
                            <div
                              className="text-destructive"
                              title="PocketBase and Garage disagree about the size quota"
                            >
                              size: Garage has{' '}
                              {formatStorage(drift.garage_quota_gb ?? 0)}
                            </div>
                          )}
                          {drift.objects_drifted && (
                            <div
                              className="text-destructive"
                              title="Garage's object cap does not match what this quota should derive"
                            >
                              objects:{' '}
                              {(drift.garage_max_objects ?? 0).toLocaleString()}{' '}
                              → expected{' '}
                              {drift.expected_max_objects == null
                                ? 'none'
                                : drift.expected_max_objects.toLocaleString()}
                            </div>
                          )}
                        </div>
                      )}
                    </TableCell>
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
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        onClick={() =>
                          setQuotaTarget({ bucket: b, audit: drift })
                        }
                      >
                        Set quota
                      </Button>
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

      {quotaTarget && (
        <SetBucketQuotaDialog
          open
          onOpenChange={(open) => {
            if (!open) setQuotaTarget(null);
          }}
          bucketId={quotaTarget.bucket.id}
          bucketName={quotaTarget.bucket.name}
          ownerEmail={
            quotaTarget.bucket.expand?.user?.email ??
            userById.get(quotaTarget.bucket.user)?.email ??
            quotaTarget.bucket.user
          }
          currentGb={quotaTarget.bucket.quota_gb ?? 0}
          garageGb={quotaTarget.audit?.garage_quota_gb ?? null}
          ownerGrantedGb={
            userById.get(quotaTarget.bucket.user)?.net_granted_gb ?? 0
          }
          // The owner's other buckets — this one's own quota is being replaced,
          // so counting it would double-charge them against their own grant.
          ownerOtherAllocatedGb={Math.max(
            (userById.get(quotaTarget.bucket.user)?.allocated_gb ?? 0) -
              (quotaTarget.bucket.quota_gb ?? 0),
            0
          )}
          onApplied={refresh}
        />
      )}
    </div>
  );
}
