'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Cable, FolderOpen } from 'lucide-react';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { api } from '@/lib/api-client';
import { formatBytes, formatStorage } from '@/lib/format';
import { describeBucketEmptiness } from '@/lib/storage/bucket-emptiness';
import { bytesToGib } from '@/lib/storage/units';
import { StorageQuotaInput } from '@/components/storage/storage-quota-input';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { OtpConfirmDeleteDialog } from '@/components/ui/otp-confirm-delete-dialog';
import { OtpVerificationDialog } from '@/components/auth/otp-gated-dialog';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import type { AccessKey, Bucket } from '@garage-ware/shared';
import type { GarageBucket } from '@/lib/garage';
import type { StorageSummary } from '@/lib/types';

interface DetailResponse {
  record: Bucket;
  garage: GarageBucket;
}

function BucketDetail({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingQuota, setSavingQuota] = useState(false);
  const [quotaInputGib, setQuotaInputGib] = useState(0);
  const [granted, setGranted] = useState(0);
  const [otherAllocated, setOtherAllocated] = useState(0);
  const [permOtpVerified, setPermOtpVerified] = useState(false);
  const [permOtpOpen, setPermOtpOpen] = useState(false);
  const pendingPermActionRef = useRef<(() => Promise<void>) | null>(null);

  // Source the granted/allocated figures from the single shared calculator
  // (`getUserStorageSummary` behind /storage-summary) so this page agrees with
  // the dashboard: net grant accounts for transfers and decommissioned nodes,
  // and "other allocated" is every bucket's quota except this one.
  function applySummary(detail: DetailResponse, summary: StorageSummary) {
    setGranted(summary.netGrantedGb);
    setOtherAllocated(
      Math.max(summary.allocatedGb - (detail.record.quota_gb ?? 0), 0)
    );
  }

  async function refresh() {
    const [detail, keysResp, summary] = await Promise.all([
      api<DetailResponse>(`/next-api/garage/buckets/${id}`),
      api<{ items: AccessKey[] }>('/next-api/garage/keys'),
      api<StorageSummary>('/next-api/garage/storage-summary'),
    ]);
    setData(detail);
    setKeys(keysResp.items);
    setQuotaInputGib(detail.record.quota_gb ?? 0);
    applySummary(detail, summary);
  }

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [detail, keysResp, summary] = await Promise.all([
          api<DetailResponse>(`/next-api/garage/buckets/${id}`),
          api<{ items: AccessKey[] }>('/next-api/garage/keys'),
          api<StorageSummary>('/next-api/garage/storage-summary'),
        ]);
        if (cancelled) return;
        setData(detail);
        setKeys(keysResp.items);
        setQuotaInputGib(detail.record.quota_gb ?? 0);
        applySummary(detail, summary);
      } catch (err) {
        if (!cancelled)
          toast.error(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function saveQuota() {
    setSavingQuota(true);
    try {
      if (!Number.isFinite(quotaInputGib) || quotaInputGib < 0) {
        throw new Error('Quota must be a non-negative number');
      }
      await api(`/next-api/garage/buckets/${id}`, {
        method: 'PATCH',
        body: { quota_gb: quotaInputGib },
      });
      toast.success('Quota updated');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setSavingQuota(false);
    }
  }

  async function handleDelete() {
    await api(`/next-api/garage/buckets/${id}`, { method: 'DELETE' });
    toast.success(`Deleted ${data?.record.name ?? 'bucket'}`);
    router.push('/dashboard/buckets');
  }

  async function applyPermissionChange(
    accessKey: AccessKey,
    perm: 'read' | 'write' | 'owner',
    enable: boolean
  ) {
    try {
      await api(`/next-api/garage/keys/${accessKey.id}/permissions`, {
        method: 'POST',
        body: {
          bucket_id: id,
          action: enable ? 'allow' : 'deny',
          permissions: { [perm]: true },
        },
      });
      toast.success(
        `${enable ? 'Allowed' : 'Denied'} ${perm} for ${accessKey.name ?? 'key'}`
      );
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    }
  }

  function togglePermission(
    accessKey: AccessKey,
    perm: 'read' | 'write' | 'owner',
    enable: boolean
  ) {
    const run = () => applyPermissionChange(accessKey, perm, enable);
    if (permOtpVerified) {
      void run();
      return;
    }
    pendingPermActionRef.current = run;
    setPermOtpOpen(true);
  }

  if (loading || !data) {
    return (
      <div className="container mx-auto px-4 py-8">
        <p>Loading...</p>
      </div>
    );
  }

  const usageBytes = data.garage.bytes ?? 0;
  const usageGb = bytesToGib(usageBytes);
  const objects = data.garage.objects ?? 0;
  const maxObjects = data.garage.quotas?.maxObjects ?? null;
  const objectFillPct =
    maxObjects && maxObjects > 0 ? (objects / maxObjects) * 100 : null;
  const objectsRemaining =
    maxObjects != null ? Math.max(maxObjects - objects, 0) : null;
  const objectRemainingPct =
    objectFillPct != null ? Math.max(100 - objectFillPct, 0) : null;
  const objectBarClass =
    objectFillPct == null
      ? 'bg-primary'
      : objectFillPct >= 90
        ? 'bg-destructive'
        : objectFillPct >= 70
          ? 'bg-amber-500'
          : 'bg-primary';

  const remaining = granted - otherAllocated - quotaInputGib;
  const quotaInvalid =
    !Number.isFinite(quotaInputGib) || quotaInputGib < 0 || remaining < 0;

  const currentQuotaGb = data.record.quota_gb ?? 0;
  const isDirty = Math.abs(quotaInputGib - currentQuotaGb) > 0.001;

  const base = Math.max(granted, quotaInputGib, usageGb, 1);
  const usedW = Math.min((usageGb / base) * 100, 100);
  const headroomW = Math.min(
    (Math.max(quotaInputGib - usageGb, 0) / base) * 100,
    100
  );
  const availableW = Math.min((Math.max(remaining, 0) / base) * 100, 100);

  const fillPct = quotaInputGib > 0 ? (usageGb / quotaInputGib) * 100 : 100;
  const fillBarClass =
    fillPct >= 90
      ? 'bg-destructive'
      : fillPct >= 70
        ? 'bg-amber-500'
        : 'bg-primary';
  const newHeadroomGb = quotaInputGib - usageGb;

  function getPermsForKey(accessKey: AccessKey) {
    const entry = data?.garage.keys?.find(
      (k) => k.accessKeyId === accessKey.garage_key_id
    );
    return entry?.permissions ?? {};
  }

  const bucketIsEmpty = describeBucketEmptiness(data.garage).empty;

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="mb-6">
        <Link
          href="/dashboard/buckets"
          className="text-sm text-muted-foreground hover:underline inline-flex items-center"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to buckets
        </Link>
        <div className="flex items-start justify-between mt-2">
          <div>
            <h1 className="text-3xl font-bold">{data.record.name}</h1>
            <p className="text-sm text-muted-foreground font-mono">
              {data.record.garage_bucket_id}
            </p>
          </div>
          <div className="flex gap-2">
            <Link href={`/dashboard/buckets/${id}/browse`}>
              <Button variant="outline" size="sm" className="gap-1.5">
                <FolderOpen className="h-4 w-4" /> Browse files
              </Button>
            </Link>
            <Link href={`/dashboard/buckets/${id}/connect`}>
              <Button variant="outline" size="sm" className="gap-1.5">
                <Cable className="h-4 w-4" /> Connect
              </Button>
            </Link>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <Card>
          <CardHeader>
            <CardTitle>Usage</CardTitle>
            <CardDescription>Live from Garage cluster.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {formatStorage(usageGb)}
            </div>
            <p className="text-sm text-muted-foreground">
              {objects.toLocaleString()} objects
              {maxObjects != null && ` / ${maxObjects.toLocaleString()} max`}
            </p>
            {currentQuotaGb > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                {Math.round(Math.min((usageGb / currentQuotaGb) * 100, 100))}%
                of {formatStorage(currentQuotaGb)} quota
              </p>
            )}
            {objectFillPct != null && (
              <p className="text-xs text-muted-foreground mt-1">
                {Math.round(Math.min(objectFillPct, 100))}% of object limit
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Quota</CardTitle>
            <CardDescription>
              Your total grant is {formatStorage(granted)} —{' '}
              {formatStorage(otherAllocated)} in other buckets,{' '}
              {formatStorage(Math.max(remaining, 0))} available to allocate.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {formatStorage(usageGb)} used /{' '}
                  {formatStorage(currentQuotaGb)} quota
                </span>
                {usageGb > currentQuotaGb && (
                  <span className="text-destructive">
                    Usage exceeds quota by{' '}
                    {formatStorage(usageGb - currentQuotaGb)}
                  </span>
                )}
              </div>
              <div className="flex h-2.5 w-full rounded-full overflow-hidden bg-muted gap-px">
                <div
                  className="bg-primary transition-all"
                  style={{ width: `${usedW}%` }}
                />
                <div
                  className="bg-primary/30 transition-all"
                  style={{ width: `${headroomW}%` }}
                />
                <div
                  className="bg-muted-foreground/20 transition-all"
                  style={{ width: `${availableW}%` }}
                />
              </div>
              <div className="flex gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                  Used: {formatStorage(usageGb)}
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary/30" />
                  Headroom:{' '}
                  {formatStorage(Math.max(currentQuotaGb - usageGb, 0))}
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                  Available: {formatStorage(Math.max(remaining, 0))}
                </span>
              </div>
            </div>

            {maxObjects != null && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>
                    {objects.toLocaleString()} used /{' '}
                    {maxObjects.toLocaleString()} objects
                  </span>
                  {objects > maxObjects ? (
                    <span className="text-destructive">
                      Over object limit by{' '}
                      {(objects - maxObjects).toLocaleString()}
                    </span>
                  ) : (
                    <span>
                      {Math.round(objectRemainingPct ?? 0)}% remaining
                    </span>
                  )}
                </div>
                <div className="flex h-2.5 w-full rounded-full overflow-hidden bg-muted">
                  <div
                    className={`transition-all ${objectBarClass}`}
                    style={{ width: `${Math.min(objectFillPct ?? 0, 100)}%` }}
                  />
                </div>
                <div className="flex gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${objectBarClass}`}
                    />
                    Objects: {objects.toLocaleString()}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                    Remaining: {(objectsRemaining ?? 0).toLocaleString()}
                  </span>
                </div>
              </div>
            )}

            <div className="flex items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="quota-input" className="text-xs">
                  Quota
                </Label>
                <StorageQuotaInput
                  id="quota-input"
                  valueGib={quotaInputGib}
                  onChangeGib={setQuotaInputGib}
                  className="w-40"
                />
              </div>
              <Button
                onClick={saveQuota}
                disabled={savingQuota || quotaInvalid}
              >
                {savingQuota
                  ? 'Saving...'
                  : isDirty
                    ? 'Save new quota'
                    : 'Save quota'}
              </Button>
            </div>

            <div className="rounded-md border bg-muted/40 px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-medium">
                  {isDirty ? 'Preview — after save' : 'Current'}
                </span>
                {isDirty && <span>from {formatStorage(currentQuotaGb)}</span>}
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-2 rounded-full overflow-hidden bg-muted">
                  <div
                    className={`h-full transition-all ${fillBarClass}`}
                    style={{ width: `${Math.min(fillPct, 100)}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {Math.round(Math.min(fillPct, 999))}% full
                </span>
              </div>
              <div className="flex gap-4 text-xs">
                <span>
                  <span className="text-muted-foreground">Headroom </span>
                  <span
                    className={
                      newHeadroomGb < 0
                        ? 'font-medium text-destructive'
                        : 'font-medium'
                    }
                  >
                    {newHeadroomGb < 0
                      ? `−${formatStorage(Math.abs(newHeadroomGb))} over`
                      : formatStorage(newHeadroomGb)}
                  </span>
                </span>
                <span>
                  <span className="text-muted-foreground">
                    Grant remaining{' '}
                  </span>
                  <span
                    className={
                      remaining < 0
                        ? 'font-medium text-destructive'
                        : 'font-medium'
                    }
                  >
                    {remaining < 0
                      ? `${formatStorage(Math.abs(remaining))} over`
                      : formatStorage(remaining)}
                  </span>
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Access keys</CardTitle>
          <CardDescription>
            Allow or deny each of your S3 keys on this bucket. Permissions are
            applied immediately on the cluster.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              You have no keys yet.{' '}
              <Link href="/dashboard/keys" className="underline">
                Create one
              </Link>
              .
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead className="text-center">Read</TableHead>
                  <TableHead className="text-center">Write</TableHead>
                  <TableHead className="text-center">Owner</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => {
                  const perms = getPermsForKey(k);
                  return (
                    <TableRow key={k.id}>
                      <TableCell className="font-medium">
                        <div>{k.name || '(unnamed)'}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {k.garage_key_id.slice(0, 12)}…
                        </div>
                      </TableCell>
                      {(['read', 'write', 'owner'] as const).map((perm) => (
                        <TableCell key={perm} className="text-center">
                          <Checkbox
                            checked={!!perms[perm]}
                            onCheckedChange={(checked) =>
                              togglePermission(k, perm, !!checked)
                            }
                          />
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <OtpVerificationDialog
        open={permOtpOpen}
        onOpenChange={(open) => {
          setPermOtpOpen(open);
          if (!open) pendingPermActionRef.current = null;
        }}
        actionLabel="change bucket permissions"
        onVerified={() => {
          setPermOtpVerified(true);
          const action = pendingPermActionRef.current;
          pendingPermActionRef.current = null;
          if (action) void action();
        }}
      />

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>
            Deleting a bucket is permanent, and Garage only allows it once the
            bucket is empty.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* The emptiness state is shown BEFORE the dialog, not discovered
              after an OTP challenge and a typed bucket name. Garage refuses a
              non-empty bucket and the app has no way to empty one, so being
              told at the end is being told too late. */}
          {!bucketIsEmpty && (
            <p className="text-sm text-muted-foreground">
              This bucket still holds{' '}
              <strong>{formatBytes(data.garage.bytes ?? 0)}</strong> across{' '}
              <strong>{(data.garage.objects ?? 0).toLocaleString()}</strong>{' '}
              object(s), so it cannot be deleted yet. Empty it with your S3
              client — the{' '}
              <Link
                href={`/dashboard/buckets/${id}/connect`}
                className="underline"
              >
                Connect page
              </Link>{' '}
              has the endpoint and credentials.
            </p>
          )}
          <OtpConfirmDeleteDialog
            trigger={
              <Button variant="destructive" disabled={!bucketIsEmpty}>
                Delete bucket
              </Button>
            }
            title={`Delete bucket ${data.record.name}`}
            description={
              <>
                <p>
                  This will permanently delete the bucket from the Garage
                  cluster and from PocketBase, along with every alias pointing
                  at it. This cannot be undone.
                </p>
                <p>
                  The bucket is empty, so no stored data is lost — and the{' '}
                  <strong>{data.record.name}</strong> name becomes available
                  again.
                </p>
              </>
            }
            confirmText={data.record.name}
            confirmLabel="Delete bucket"
            otpActionLabel="delete this bucket"
            onConfirm={handleDelete}
          />
        </CardContent>
      </Card>
    </div>
  );
}

export default function BucketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <ProtectedRoute>
      <BucketDetail id={id} />
    </ProtectedRoute>
  );
}
