'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus } from 'lucide-react';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { api } from '@/lib/api-client';
import { formatStorage } from '@/lib/format';
import { bytesToGib } from '@/lib/storage/units';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StorageQuotaInput } from '@/components/storage/storage-quota-input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { BucketWithUsage, StorageSummary } from '@/lib/types';

function BucketsView() {
  const router = useRouter();
  const [buckets, setBuckets] = useState<BucketWithUsage[]>([]);
  const [granted, setGranted] = useState(0);
  const [allocated, setAllocated] = useState(0);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  // Net grant and allocated total both come from the single shared calculator
  // (`getUserStorageSummary` behind /storage-summary) so transfers and
  // decommissioned-node filtering are accounted for, matching the dashboard.
  async function refresh() {
    const [bucketsResp, summary] = await Promise.all([
      api<{ items: BucketWithUsage[] }>('/next-api/garage/buckets'),
      api<StorageSummary>('/next-api/garage/storage-summary'),
    ]);
    setBuckets(bucketsResp.items);
    setGranted(summary.netGrantedGb);
    setAllocated(summary.allocatedGb);
  }

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [bucketsResp, summary] = await Promise.all([
          api<{ items: BucketWithUsage[] }>('/next-api/garage/buckets'),
          api<StorageSummary>('/next-api/garage/storage-summary'),
        ]);
        if (cancelled) return;
        setBuckets(bucketsResp.items);
        setGranted(summary.netGrantedGb);
        setAllocated(summary.allocatedGb);
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
  }, []);

  const free = Math.max(granted - allocated, 0);

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="mb-6">
        <Link
          href="/dashboard"
          className="text-sm text-muted-foreground hover:underline inline-flex items-center"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to dashboard
        </Link>
        <div className="mt-2 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Buckets</h1>
            <p className="text-muted-foreground">
              {formatStorage(allocated)} allocated of {formatStorage(granted)} (
              {formatStorage(free)} free)
            </p>
          </div>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button disabled={free <= 0}>
                <Plus className="mr-2 h-4 w-4" /> New bucket
              </Button>
            </DialogTrigger>
            <CreateBucketDialog
              maxGb={free}
              onCreated={async () => {
                setCreateOpen(false);
                await refresh();
              }}
            />
          </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your buckets</CardTitle>
          <CardDescription>
            Each bucket gets a slice of your total storage claim.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : buckets.length === 0 ? (
            <p className="text-muted-foreground">No buckets yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Used</TableHead>
                  <TableHead>Quota</TableHead>
                  <TableHead>Garage ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {buckets.map((b) => {
                  const usedGb = bytesToGib(b.bytes ?? 0);
                  const quotaGb = b.quota_gb ?? 0;
                  const pct =
                    quotaGb > 0 ? Math.round((usedGb / quotaGb) * 100) : null;
                  return (
                    <TableRow
                      key={b.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/dashboard/buckets/${b.id}`)}
                    >
                      <TableCell className="font-medium">{b.name}</TableCell>
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
                      <TableCell className="font-mono text-xs">
                        {b.garage_bucket_id.slice(0, 12)}…
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CreateBucketDialog({
  maxGb,
  onCreated,
}: {
  maxGb: number;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [quotaGib, setQuotaGib] = useState(() => {
    // Default 1 TB, capped at the user's free claim
    const oneTbInGib = 931.3225746;
    return Math.min(oneTbInGib, maxGb);
  });
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (!Number.isFinite(quotaGib) || quotaGib < 0) {
        throw new Error('Quota must be a non-negative number');
      }
      if (quotaGib > maxGb) {
        throw new Error(
          `Quota exceeds your free claim (${formatStorage(maxGb)} available)`
        );
      }
      await api('/next-api/garage/buckets', {
        method: 'POST',
        body: { name, quota_gb: quotaGib },
      });
      toast.success(`Created ${name}`);
      setName('');
      setQuotaGib(0);
      await onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DialogContent>
      <form onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>Create bucket</DialogTitle>
          <DialogDescription>
            Bucket names must be globally unique within the cluster and follow
            S3 naming rules.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="bucket-name">Name</Label>
            <Input
              id="bucket-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-data"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bucket-quota">Quota</Label>
            <StorageQuotaInput
              id="bucket-quota"
              valueGib={quotaGib}
              onChangeGib={setQuotaGib}
              maxGib={maxGb}
              required
            />
            <p className="text-xs text-muted-foreground">
              {formatStorage(maxGb)} available. Set 0 for unlimited within your
              claim.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export default function BucketsPage() {
  return (
    <ProtectedRoute>
      <BucketsView />
    </ProtectedRoute>
  );
}
