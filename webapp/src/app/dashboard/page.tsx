'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, HardDrive, KeyRound, Server, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { api } from '@/lib/api-client';
import { formatStorage } from '@/lib/format';
import { bytesToGib } from '@/lib/storage/units';
import { StorageClaimChart } from '@/components/storage/storage-claim-chart';
import { StorageTransfersCard } from '@/components/storage/storage-transfers-card';
import { TransferDialog } from '@/components/storage/transfer-dialog';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { BucketTable } from '@/components/storage/bucket-table';
import { Button } from '@/components/ui/button';
import type { AccessKey, StorageInvite } from '@garage-ware/shared';
import type {
  BucketWithUsage,
  LabelledTransfer,
  StorageSummary,
} from '@/lib/types';

interface NodeInfo {
  id: string;
  zone: string;
  tags: string[];
}

interface TransfersResponse {
  sent: LabelledTransfer[];
  received: LabelledTransfer[];
  invites: StorageInvite[];
}

interface DashboardData {
  buckets: BucketWithUsage[];
  keys: AccessKey[];
  summary: StorageSummary;
  transfers: TransfersResponse;
  nodeMap: Record<string, NodeInfo>;
  usedGb: number;
}

interface ClaimResponse {
  claimed: unknown[];
  failed: { reason: string }[];
  claimedGb: number;
}

async function loadData(): Promise<DashboardData> {
  const [bucketsResp, keysResp, summaryResp, nodesResp, transfersResp] =
    await Promise.all([
      api<{ items: BucketWithUsage[] }>('/next-api/garage/buckets'),
      api<{ items: AccessKey[] }>('/next-api/garage/keys'),
      api<StorageSummary>('/next-api/garage/storage-summary'),
      api<{ items: NodeInfo[] }>('/next-api/garage/cluster/nodes'),
      api<TransfersResponse>('/next-api/garage/transfers'),
    ]);
  const usedBytes = bucketsResp.items.reduce(
    (sum, b) => sum + (b.bytes ?? 0),
    0
  );
  const nodeMap = Object.fromEntries(nodesResp.items.map((n) => [n.id, n]));
  return {
    buckets: bucketsResp.items,
    keys: keysResp.items,
    summary: summaryResp,
    transfers: transfersResp,
    nodeMap,
    usedGb: bytesToGib(usedBytes),
  };
}

/**
 * Collect anything invited to this account before rendering the dashboard.
 *
 * This is the last step of the invite flow: someone was given storage by email
 * before they had an account, and this is where that promise becomes a real
 * transfer. It runs on every load and is idempotent, so the quiet path is one
 * indexed lookup.
 *
 * Deliberately non-fatal. The claim needs the cluster layout to value the
 * sender's position, so it fails when Garage is unreachable — and a dashboard
 * that refuses to render because an *optional* pickup failed would be a much
 * worse trade than a claim that waits for the next visit.
 */
async function claimPendingInvites(): Promise<ClaimResponse | null> {
  try {
    return await api<ClaimResponse>('/next-api/garage/invites/claim', {
      method: 'POST',
    });
  } catch {
    return null;
  }
}

function StorageDashboard() {
  const { isAdmin } = useAdminStatus();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const claim = await claimPendingInvites();
        const result = await loadData();
        if (cancelled) return;
        setData(result);
        if (claim && claim.claimedGb > 0) {
          toast.success(
            `${formatStorage(claim.claimedGb)} of invited storage added to your account`
          );
        }
        for (const failure of claim?.failed ?? []) {
          toast.error(`An invite could not be collected: ${failure.reason}`);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load');
        }
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    try {
      setData(await loadData());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refresh failed');
    }
  }

  async function handleReturnTransfer(transferId: string) {
    try {
      await api(`/next-api/garage/transfers/${transferId}`, {
        method: 'DELETE',
      });
      toast.success('Transfer returned');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Return failed');
    }
  }

  async function handleCancelInvite(inviteId: string) {
    try {
      await api(`/next-api/garage/invites/${inviteId}`, { method: 'DELETE' });
      toast.success('Invite removed');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove');
    }
  }

  const summary = data?.summary;

  // The per-node breakdown arrives already rolled up — the server reads it from
  // the materialized balances rather than summing the ledger. A node whose
  // entries net to zero is no longer a claim worth listing.
  const claimsByNode = useMemo(
    () => (summary?.nodeClaims ?? []).filter((n) => n.claimedGb !== 0),
    [summary?.nodeClaims]
  );

  const available = summary?.availableGb ?? 0;
  const invites = data?.transfers.invites ?? [];
  const promisedGb = invites
    .filter((i) => i.status === 'pending')
    .reduce((sum, i) => sum + (Number(i.quota_gb) || 0), 0);

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Storage dashboard</h1>
          <p className="text-muted-foreground">
            Manage your buckets, access keys, and storage allocation.
          </p>
        </div>
        {isAdmin && (
          <Link href="/admin">
            <Button variant="outline">
              <Shield className="mr-2 h-4 w-4" />
              Admin console
            </Button>
          </Link>
        )}
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Storage claim</CardTitle>
            <CardDescription>
              What you have been granted, where it came from, and how much of it
              is still free.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {summary && data ? (
              <StorageClaimChart
                claimsGb={summary.claimsGb}
                receivedGb={summary.receivedGb}
                sentGb={summary.sentGb}
                netGrantedGb={summary.netGrantedGb}
                allocatedGb={summary.allocatedGb}
                storedGb={data.usedGb}
                bucketCount={data.buckets.length}
              />
            ) : (
              <div
                className="h-36 animate-pulse rounded bg-muted"
                aria-label="Loading storage breakdown"
              />
            )}
          </CardContent>
        </Card>

        {/* Keys are managed on their own page; this is a signpost, not a list.
            The secret is only ever shown once at creation, so there is nothing
            here worth displaying. */}
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Access keys
            </CardTitle>
            <CardDescription>
              The S3 credentials your tools use to reach your buckets.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            {data ? (
              <>
                <p className="text-3xl font-bold tabular-nums">
                  {data.keys.length}
                </p>
                <p className="text-sm text-muted-foreground">
                  {data.keys.length === 1 ? 'key' : 'keys'} on this account —
                  grant each one access per bucket.
                </p>
              </>
            ) : (
              <div
                className="h-12 animate-pulse rounded bg-muted"
                aria-label="Loading access keys"
              />
            )}
          </CardContent>
          <CardFooter className="border-t pt-4">
            <Link href="/dashboard/keys" className="w-full">
              <Button
                className="w-full"
                variant={data && data.keys.length > 0 ? 'outline' : 'default'}
              >
                Manage keys <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </CardFooter>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            Buckets
          </CardTitle>
          <CardDescription>
            {data
              ? `${data.buckets.length} bucket${data.buckets.length === 1 ? '' : 's'} — click a column to sort.`
              : 'Loading...'}
          </CardDescription>
          <CardAction>
            <Link href="/dashboard/buckets">
              <Button
                variant={
                  data && data.buckets.length > 0 ? 'outline' : 'default'
                }
              >
                Manage buckets <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </CardAction>
        </CardHeader>
        <CardContent>
          {data ? (
            <BucketTable
              buckets={data.buckets}
              emptyMessage="No buckets yet — create one to start storing data."
            />
          ) : (
            <p className="text-sm text-muted-foreground">Loading...</p>
          )}
        </CardContent>
      </Card>

      {/* Two views of the same grant: by person, and by machine. */}
      <div className="mb-6 grid gap-6 lg:grid-cols-2 lg:items-start">
        <StorageTransfersCard
          received={data?.transfers.received ?? []}
          sent={data?.transfers.sent ?? []}
          invites={invites}
          availableGb={available}
          loading={!data}
          onTransfer={() => setTransferOpen(true)}
          onReturn={handleReturnTransfer}
          onCancelInvite={handleCancelInvite}
        />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              Storage nodes
            </CardTitle>
            <CardDescription>
              Your storage quota by node —{' '}
              <strong>{formatStorage(available)}</strong> remaining overall
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!data ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : claimsByNode.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No node claims yet. An administrator grants storage per cluster
                node; transfers from other users are not tied to one.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b">
                    <th className="text-left pb-2 font-medium">Node</th>
                    <th className="text-left pb-2 font-medium">Tags</th>
                    <th className="text-right pb-2 font-medium">Claimed</th>
                  </tr>
                </thead>
                <tbody>
                  {claimsByNode.map((node) => {
                    const tags = data.nodeMap[node.nodeId]?.tags ?? [];
                    return (
                      <tr key={node.nodeId} className="border-b last:border-0">
                        <td className="py-2">
                          <span className="font-mono">
                            {node.nodeHostname ?? node.nodeId.slice(0, 12)}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {node.nodeZone || 'no zone'}
                          </span>
                        </td>
                        <td className="py-2 text-muted-foreground">
                          {tags.length > 0 ? tags.join(', ') : '—'}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {formatStorage(node.claimedGb)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      <TransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        availableGb={available}
        promisedGb={promisedGb}
        onSent={refresh}
      />

      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <StorageDashboard />
    </ProtectedRoute>
  );
}
