'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus } from 'lucide-react';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { api } from '@/lib/api-client';
import { formatStorage } from '@/lib/format';
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
import { BucketMetrics } from '@/components/storage/bucket-metrics';
import { BucketTable } from '@/components/storage/bucket-table';
import type { BucketWithUsage, StorageSummary } from '@/lib/types';

function BucketsView() {
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

      <BucketMetrics
        buckets={buckets}
        allocatedGb={allocated}
        grantedGb={granted}
        className="mb-6"
      />

      <Card>
        <CardHeader>
          <CardTitle>Your buckets</CardTitle>
          <CardDescription>
            Each bucket gets a slice of your total storage quota. Click a column
            to sort.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : (
            <BucketTable buckets={buckets} />
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
    // Default 1 TB, capped at the user's unallocated quota
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
          `Quota exceeds your unallocated storage (${formatStorage(maxGb)} available)`
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
              quota.
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
