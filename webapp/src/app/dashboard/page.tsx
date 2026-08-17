'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  ChartLine,
  HardDrive,
  KeyRound,
  Server,
  ServerCog,
  Settings,
  Shield,
} from 'lucide-react';
import { toast } from 'sonner';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { useAuth } from '@/hooks/use-auth';
import { api } from '@/lib/api-client';
import { formatStorage } from '@/lib/format';
import { nodeKey, nodeLabel, parseNodeTags } from '@/lib/node-label';
import { nodeUsableGbFrom } from '@/lib/storage/ledger-math';
import { bytesToGib, gibToBytes } from '@/lib/storage/units';
import { usePricingConfig } from '@/lib/pricing/use-pricing-config';
import { StorageClaimChart } from '@/components/storage/storage-claim-chart';
import { StorageCostSummary } from '@/components/storage/storage-cost-summary';
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
import type { AccessKey, NodeOwner, StorageInvite } from '@garage-ware/shared';
import type {
  BucketWithUsage,
  ClusterNodeItem,
  ClusterNodesResponse,
  LabelledTransfer,
  StorageSummary,
} from '@/lib/types';

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
  nodeMap: Record<string, ClusterNodeItem>;
  /** Cluster nodes this user owns — what backs the "Nodes you own" card. */
  ownedNodes: NodeOwner[];
  usedGb: number;
  /** The cluster's replication factor — a term in the hardware cost. */
  replicationFactor: number;
}

interface ClaimResponse {
  claimed: unknown[];
  failed: { reason: string }[];
  claimedGb: number;
}

async function loadData(): Promise<DashboardData> {
  const [
    bucketsResp,
    keysResp,
    summaryResp,
    nodesResp,
    transfersResp,
    ownersResp,
  ] = await Promise.all([
    api<{ items: BucketWithUsage[] }>('/next-api/garage/buckets'),
    api<{ items: AccessKey[] }>('/next-api/garage/keys'),
    api<StorageSummary>('/next-api/garage/storage-summary'),
    api<ClusterNodesResponse>('/next-api/garage/cluster/nodes'),
    api<TransfersResponse>('/next-api/garage/transfers'),
    // Self-scoped and PocketBase-only — it makes no Garage call, so adding it
    // here costs the dashboard no new way to fail.
    api<{ items: NodeOwner[] }>('/next-api/garage/nodes/owners'),
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
    ownedNodes: ownersResp.items,
    usedGb: bytesToGib(usedBytes),
    replicationFactor: nodesResp.replicationFactor,
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
  // Already in context — the account card needs no fetch of its own.
  const { user } = useAuth();
  // Deliberately its own fetch, not a sixth call in `loadData`: a failure there
  // sets `error` and the whole dashboard renders as an error string, and a
  // cosmetic panel must never be able to do that. The hook falls back to the
  // built-in defaults rather than reporting null, so there is no failure state
  // to render — a deployment that has configured nothing gets the same numbers.
  const { config: pricing } = usePricingConfig();
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

  // What the nodes this user owns can back in total. `nodeUsableGbFrom`
  // returns null for a node with no declared capacity (a gateway) and for one
  // that has left the layout, both of which contribute nothing.
  const ownedUsableGb = useMemo(() => {
    if (!data) return 0;
    return data.ownedNodes.reduce(
      (sum, owner) =>
        sum +
        (nodeUsableGbFrom(
          data.nodeMap[owner.node_id]?.capacity,
          data.replicationFactor
        ) ?? 0),
      0
    );
  }, [data]);

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
            <CardTitle>Storage quota</CardTitle>
            <CardDescription>
              Everything granted to you and gifted by others, where it came
              from, and how much of it is still free.
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

      <StorageCostSummary
        className="mb-6"
        quotaBytes={summary ? gibToBytes(summary.netGrantedGb) : 0}
        replicationFactor={data?.replicationFactor ?? 1}
        pricing={pricing}
        loading={!data}
      />

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
                No node quotas yet. An administrator grants storage per cluster
                node, and{' '}
                <Link href="/dashboard/nodes" className="underline">
                  claiming a node you contributed
                </Link>{' '}
                lets you grant it yourself. Storage gifted by other users is not
                tied to a node.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b">
                    <th className="text-left pb-2 font-medium">Node</th>
                    <th className="text-left pb-2 font-medium">Tags</th>
                    <th className="text-right pb-2 font-medium">Quota</th>
                  </tr>
                </thead>
                <tbody>
                  {claimsByNode.map((node) => {
                    // `rest` drops the tag the name came from, so it does not
                    // also appear in the Tags column beside it.
                    const { name, rest } = parseNodeTags(
                      data.nodeMap[node.nodeId]?.tags
                    );
                    return (
                      <tr key={node.nodeId} className="border-b last:border-0">
                        <td className="py-2">
                          <span className={name ? undefined : 'font-mono'}>
                            {nodeLabel(name, node.nodeId)}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {name ? `${nodeKey(node.nodeId)} · ` : ''}
                            {node.nodeZone || 'no zone'}
                          </span>
                        </td>
                        <td className="py-2 text-muted-foreground">
                          {rest.length > 0 ? rest.join(', ') : '—'}
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
          <CardFooter className="flex gap-2 border-t pt-4">
            <Link href="/dashboard/cluster" className="flex-1">
              <Button variant="outline" className="w-full">
                <Server className="mr-2 h-4 w-4" /> Cluster
              </Button>
            </Link>
            <Link href="/dashboard/metrics" className="flex-1">
              <Button variant="outline" className="w-full">
                <ChartLine className="mr-2 h-4 w-4" /> Metrics
              </Button>
            </Link>
          </CardFooter>
        </Card>
      </div>

      {/* Every destination in the nav gets a card here. The desktop bar shows
          three of them inline and hides the rest behind the avatar dropdown, so
          a user who never opens that menu would otherwise have no way to find
          "My nodes" or their own account settings. */}
      <div className="mb-6 grid gap-6 lg:grid-cols-2 lg:items-start">
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ServerCog className="h-5 w-5" />
              Nodes you own
            </CardTitle>
            <CardDescription>
              Claim a machine you contributed to the cluster and grant storage
              sourced from it — to yourself or to anyone else by email.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            {!data ? (
              <div
                className="h-12 animate-pulse rounded bg-muted"
                aria-label="Loading owned nodes"
              />
            ) : data.ownedNodes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You don&apos;t own any cluster nodes yet. If you run one, claim
                it with the full node id that <code>garage node id</code> prints
                on the machine.
              </p>
            ) : (
              <>
                <p className="text-3xl font-bold tabular-nums">
                  {data.ownedNodes.length}
                </p>
                <p className="text-sm text-muted-foreground">
                  {data.ownedNodes.length === 1 ? 'node' : 'nodes'} owned —{' '}
                  <strong>{formatStorage(ownedUsableGb)}</strong> of usable
                  capacity you can grant from.
                </p>
              </>
            )}
          </CardContent>
          <CardFooter className="border-t pt-4">
            <Link href="/dashboard/nodes" className="w-full">
              <Button
                className="w-full"
                variant={
                  data && data.ownedNodes.length > 0 ? 'outline' : 'default'
                }
              >
                {data && data.ownedNodes.length > 0
                  ? 'Manage my nodes'
                  : 'Claim a node'}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </CardFooter>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Account
            </CardTitle>
            <CardDescription>
              Your name, password, and when we email you about a bucket filling
              up.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1 space-y-1">
            <p className="text-sm font-medium">{user?.name || 'User'}</p>
            <p className="text-sm text-muted-foreground">{user?.email}</p>
            <p className="text-sm text-muted-foreground">
              Fill alerts at{' '}
              <strong>{user?.notification_threshold_pct ?? 90}%</strong> of a
              bucket&apos;s quota.
            </p>
          </CardContent>
          <CardFooter className="border-t pt-4">
            <Link href="/profile" className="w-full">
              <Button className="w-full" variant="outline">
                Profile settings <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </CardFooter>
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
