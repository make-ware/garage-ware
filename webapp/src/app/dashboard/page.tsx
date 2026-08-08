'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  HardDrive,
  KeyRound,
  Server,
  Shield,
  ArrowLeftRight,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { api } from '@/lib/api-client';
import { formatStorage } from '@/lib/format';
import { bytesToGib } from '@/lib/storage/units';
import { StorageQuotaInput } from '@/components/storage/storage-quota-input';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { BucketTable } from '@/components/storage/bucket-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import type { AccessKey } from '@garage-ware/shared';
import type { BucketWithUsage, StorageSummary } from '@/lib/types';

interface NodeInfo {
  id: string;
  zone: string;
  tags: string[];
}

interface DashboardData {
  buckets: BucketWithUsage[];
  keys: AccessKey[];
  summary: StorageSummary;
  nodeMap: Record<string, NodeInfo>;
  usedGb: number;
}

function StorageDashboard() {
  const { isAdmin } = useAdminStatus();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTransferForm, setShowTransferForm] = useState(false);
  const [transferEmail, setTransferEmail] = useState('');
  const [transferGib, setTransferGib] = useState(0);
  const [transferNote, setTransferNote] = useState('');
  const [transferring, setTransferring] = useState(false);

  async function loadData(): Promise<DashboardData> {
    const [bucketsResp, keysResp, summaryResp, nodesResp] = await Promise.all([
      api<{ items: BucketWithUsage[] }>('/next-api/garage/buckets'),
      api<{ items: AccessKey[] }>('/next-api/garage/keys'),
      api<StorageSummary>('/next-api/garage/storage-summary'),
      api<{ items: NodeInfo[] }>('/next-api/garage/cluster/nodes'),
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
      nodeMap,
      usedGb: bytesToGib(usedBytes),
    };
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const result = await loadData();
        if (!cancelled) setData(result);
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

  async function handleReturnTransfer(transferId: string) {
    try {
      await api(`/next-api/garage/transfers/${transferId}`, {
        method: 'DELETE',
      });
      toast.success('Transfer returned');
      const result = await loadData();
      setData(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Return failed');
    }
  }

  async function handleSendTransfer(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!transferEmail.trim()) {
      toast.error('Recipient email is required');
      return;
    }
    if (!Number.isFinite(transferGib) || transferGib <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    const quota_gb = transferGib;
    setTransferring(true);
    try {
      await api('/next-api/garage/transfers', {
        method: 'POST',
        body: {
          to_user_email: transferEmail.trim(),
          quota_gb,
          note: transferNote.trim() || undefined,
        },
      });
      toast.success('Storage transferred');
      setTransferEmail('');
      setTransferGib(0);
      setTransferNote('');
      setShowTransferForm(false);
      const result = await loadData();
      setData(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Transfer failed');
    } finally {
      setTransferring(false);
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

  const netGranted = summary?.netGrantedGb ?? 0;
  const allocated = summary?.allocatedGb ?? 0;
  const available = summary?.availableGb ?? 0;
  const usedPct =
    netGranted > 0 ? Math.min((allocated / netGranted) * 100, 100) : 0;
  const hasBreakdown =
    summary && (summary.receivedGb > 0 || summary.sentGb > 0);

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
              Your total granted quota and how much is allocated to buckets.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between text-sm">
              <span>
                Allocated: <strong>{formatStorage(allocated)}</strong> of{' '}
                {formatStorage(netGranted)}
              </span>
              <span className="text-muted-foreground">
                {formatStorage(available)} free
              </span>
            </div>
            <Progress value={usedPct} />

            {hasBreakdown && (
              <div className="text-xs text-muted-foreground space-y-0.5 border-l-2 pl-3 border-muted">
                <div className="flex justify-between">
                  <span>From admin (claims)</span>
                  <span>{formatStorage(summary.claimsGb)}</span>
                </div>
                {summary.receivedGb > 0 && (
                  <div className="flex justify-between text-green-700 dark:text-green-400">
                    <span>Received transfers</span>
                    <span>+{formatStorage(summary.receivedGb)}</span>
                  </div>
                )}
                {summary.sentGb > 0 && (
                  <div className="flex justify-between text-orange-700 dark:text-orange-400">
                    <span>Sent transfers</span>
                    <span>−{formatStorage(summary.sentGb)}</span>
                  </div>
                )}
              </div>
            )}

            {netGranted === 0 && (
              <p className="text-sm text-muted-foreground">
                Your storage quota is 0 GB. Ask an administrator to grant you a
                claim before creating buckets.
              </p>
            )}
            {data && data.buckets.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Storage used: <strong>{formatStorage(data.usedGb)}</strong>{' '}
                across {data.buckets.length} bucket
                {data.buckets.length === 1 ? '' : 's'}
              </p>
            )}

            {available > 0 && (
              <div className="pt-1">
                {!showTransferForm ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowTransferForm(true)}
                  >
                    <ArrowLeftRight className="mr-2 h-4 w-4" />
                    Transfer storage
                  </Button>
                ) : (
                  <form
                    onSubmit={handleSendTransfer}
                    className="space-y-3 border rounded-md p-4 bg-muted/30"
                  >
                    <p className="text-sm font-medium">
                      Transfer storage to another user
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Available to transfer: {formatStorage(available)}
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-2 space-y-1">
                        <Label htmlFor="transfer-email">Recipient email</Label>
                        <Input
                          id="transfer-email"
                          type="email"
                          placeholder="user@example.com"
                          value={transferEmail}
                          onChange={(e) => setTransferEmail(e.target.value)}
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="transfer-amount">Amount</Label>
                        <StorageQuotaInput
                          id="transfer-amount"
                          valueGib={transferGib}
                          onChangeGib={setTransferGib}
                          maxGib={available}
                          min={0.001}
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="transfer-note">Note (optional)</Label>
                        <Input
                          id="transfer-note"
                          placeholder="Reason…"
                          value={transferNote}
                          onChange={(e) => setTransferNote(e.target.value)}
                          maxLength={500}
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" disabled={transferring}>
                        {transferring ? 'Transferring…' : 'Transfer'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowTransferForm(false);
                          setTransferEmail('');
                          setTransferGib(0);
                          setTransferNote('');
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Access keys
            </CardTitle>
            <CardDescription>
              {data ? `${data.keys.length} keys` : 'Loading...'} — S3
              credentials for your applications and clients.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/dashboard/keys">
              <Button variant="outline">
                Manage keys <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </CardContent>
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

      {summary && summary.receivedTransfers.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowLeftRight className="h-5 w-5" />
              Received transfers
            </CardTitle>
            <CardDescription>
              Storage transferred to you — you can return a transfer if your
              bucket quotas fit within your remaining capacity.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b">
                  <th className="text-left pb-2 font-medium">From</th>
                  <th className="text-left pb-2 font-medium">Amount</th>
                  <th className="text-left pb-2 font-medium">Note</th>
                  <th className="text-right pb-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {summary.receivedTransfers.map((t) => (
                  <tr key={t.id} className="border-b last:border-0">
                    <td className="py-2 font-mono text-xs">{t.from_user}</td>
                    <td className="py-2">{formatStorage(t.quota_gb)}</td>
                    <td className="py-2 text-muted-foreground max-w-[200px] truncate">
                      {t.note || '—'}
                    </td>
                    <td className="py-2 text-right">
                      <ConfirmDeleteDialog
                        trigger={
                          <Button variant="ghost" size="sm">
                            <Undo2 className="h-4 w-4 mr-1" />
                            Return
                          </Button>
                        }
                        title="Return this transfer?"
                        description={`This will return ${formatStorage(t.quota_gb)} to the original sender. Make sure your bucket quotas don't exceed your remaining capacity.`}
                        confirmText="return"
                        confirmLabel="Return"
                        onConfirm={() => handleReturnTransfer(t.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {data && summary && claimsByNode.length > 0 && (
        <Card className="mb-6">
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
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b">
                  <th className="text-left pb-2 font-medium">Node</th>
                  <th className="text-left pb-2 font-medium">Zone</th>
                  <th className="text-left pb-2 font-medium">Tags</th>
                  <th className="text-right pb-2 font-medium">Claimed</th>
                </tr>
              </thead>
              <tbody>
                {claimsByNode.map((node) => {
                  const tags = data.nodeMap[node.nodeId]?.tags ?? [];
                  return (
                    <tr key={node.nodeId} className="border-b last:border-0">
                      <td className="py-2 font-mono">
                        {node.nodeHostname ?? node.nodeId.slice(0, 12)}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {node.nodeZone || '—'}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {tags.length > 0 ? tags.join(', ') : '—'}
                      </td>
                      <td className="py-2 text-right">
                        {formatStorage(node.claimedGb)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

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
