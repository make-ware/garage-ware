'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { SetClaimDialog } from '@/components/admin/set-claim-dialog';
import { NodeIdentity } from '@/components/cluster/node-identity';
import { api } from '@/lib/api-client';
import { formatStorage } from '@/lib/format';
import { isFullNodeId, nodeLabel, parseNodeTags } from '@/lib/node-label';
import { nodeUsableGbFrom } from '@/lib/storage/ledger-math';
import { sumEntries } from '@garage-ware/shared/mutators';
import type { NodeOwner, StorageClaim } from '@garage-ware/shared';
import type { ClusterNodeItem, ClusterNodesResponse } from '@/lib/types';

/**
 * "My nodes" — claim a cluster node and manage the storage sourced from it.
 *
 * Owning a node lets you append claim entries against it, to yourself or to
 * anyone else by email. It does not raise the ceiling: every grant made here
 * goes through the same per-node invariant an admin's does, so the node can
 * back no more than `capacity / replicationFactor` in total.
 *
 * The node id is typed in rather than picked from a list on purpose, and this
 * is the only surface in the app where a **full** node id appears at all: you
 * are meant to have it because you run the machine, and possession of it is
 * what the claim proves. Everything else here — including the rows below —
 * shows the 16-character node key. See webapp/src/lib/node-label.ts.
 */

interface OwnedNode {
  record: NodeOwner;
  node: ClusterNodeItem | null;
  usableGb: number;
  claimedGb: number;
  claims: StorageClaim[];
}

function NodesView() {
  const [owned, setOwned] = useState<OwnedNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [nodeIdInput, setNodeIdInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [grantFor, setGrantFor] = useState<{
    nodeId: string;
    nodeName: string | null;
    freeGb: number;
  } | null>(null);

  async function loadOwned(): Promise<OwnedNode[]> {
    const [ownersResp, nodesResp] = await Promise.all([
      api<{ items: NodeOwner[] }>('/next-api/garage/nodes/owners'),
      api<ClusterNodesResponse>('/next-api/garage/cluster/nodes'),
    ]);

    const byId = new Map(nodesResp.items.map((n) => [n.id, n]));
    const rf = nodesResp.replicationFactor;

    return Promise.all(
      ownersResp.items.map(async (record) => {
        const node = byId.get(record.node_id) ?? null;
        // The one implementation of capacity / replicationFactor. Hand-rolling
        // it here is how the admin console and the dashboard came to disagree
        // before, and it clamps the RF so an unreadable one cannot inflate the
        // figure.
        const usableGb = nodeUsableGbFrom(node?.capacity, rf) ?? 0;
        // Owning the node is what makes this read allowed; it returns every
        // user's entries on it, which is what "manage the node" requires.
        const claims = await api<{ items: StorageClaim[] }>(
          `/next-api/garage/claims?nodeId=${encodeURIComponent(record.node_id)}`
        ).then(
          (r) => r.items,
          () => [] as StorageClaim[]
        );
        return {
          record,
          node,
          usableGb,
          claimedGb: sumEntries(claims),
          claims,
        };
      })
    );
  }

  async function refresh() {
    setOwned(await loadOwned());
  }

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await loadOwned();
        if (cancelled) return;
        setOwned(rows);
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

  async function claimNode(e: React.FormEvent) {
    e.preventDefault();
    // `garage node id` prints `<id>@<addr>`; take the id half, as the route
    // does. Validated here as well as server-side so pasting the key that is
    // on screen fails immediately, with an explanation, rather than after a
    // round trip that can only answer 404.
    const nodeId = nodeIdInput.trim().split('@')[0].trim().toLowerCase();
    if (!nodeId) return;
    if (!isFullNodeId(nodeId)) {
      toast.error(
        'That is not a full node id. Run `garage node id` on the machine — the short key shown here is not enough to claim it.'
      );
      return;
    }
    setClaiming(true);
    try {
      await api('/next-api/garage/nodes/owners', {
        method: 'POST',
        body: {
          node_id: nodeId,
          ...(noteInput.trim() ? { note: noteInput.trim() } : {}),
        },
      });
      toast.success('Node claimed');
      setNodeIdInput('');
      setNoteInput('');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Claim failed');
    } finally {
      setClaiming(false);
    }
  }

  async function release(row: OwnedNode) {
    await api(`/next-api/garage/nodes/owners/${row.record.id}`, {
      method: 'DELETE',
    });
    toast.success('Node released');
    await refresh();
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="mb-6">
        <Link
          href="/dashboard"
          className="text-sm text-muted-foreground hover:underline inline-flex items-center"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">My nodes</h1>
        <p className="text-sm text-muted-foreground">
          Claim a node you contributed and share out the storage it backs.
        </p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Claim a node</CardTitle>
          <CardDescription>
            Run <code className="font-mono">garage node id</code> on the machine
            and paste what it prints. Knowing that id is what proves the node is
            yours, so it is the one thing the short key shown elsewhere in the
            app cannot stand in for. Claiming lets you grant the node&apos;s
            storage; it does not change the cluster layout.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={claimNode} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="claim-node-id">Full node id</Label>
              <Input
                id="claim-node-id"
                value={nodeIdInput}
                onChange={(e) => setNodeIdInput(e.target.value)}
                placeholder="64 hex characters, or id@address"
                className="font-mono"
                // 64 for the id, 1 for the `@`, and room for the address half
                // that `garage node id` prints and this form discards.
                maxLength={200}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="claim-node-note">Note (optional)</Label>
              <Input
                id="claim-node-note"
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                placeholder="e.g. the box in the garage"
                maxLength={500}
              />
            </div>
            <Button type="submit" disabled={claiming || !nodeIdInput.trim()}>
              <Plus className="mr-1 h-4 w-4" />
              {claiming ? 'Claiming...' : 'Claim node'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : owned.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You do not own any nodes yet.
        </p>
      ) : (
        owned.map((row) => {
          const name = row.node ? parseNodeTags(row.node.tags).name : null;
          const freeGb = Math.max(row.usableGb - row.claimedGb, 0);
          return (
            <Card key={row.record.id} className="mb-4">
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <NodeIdentity name={name} nodeId={row.record.node_id} />
                      {row.node ? (
                        <Badge variant="outline">{row.node.zone}</Badge>
                      ) : (
                        <Badge variant="destructive">Not in layout</Badge>
                      )}
                    </CardTitle>
                    <CardDescription>
                      {row.record.note || 'No note'}
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() =>
                        setGrantFor({
                          nodeId: row.record.node_id,
                          nodeName: name,
                          freeGb,
                        })
                      }
                      disabled={!row.node}
                    >
                      Grant storage
                    </Button>
                    <ConfirmDeleteDialog
                      trigger={
                        <Button size="sm" variant="outline">
                          Release
                        </Button>
                      }
                      title="Release this node"
                      description={
                        <>
                          Releasing makes{' '}
                          <strong>{nodeLabel(name, row.record.node_id)}</strong>{' '}
                          claimable by someone else. Storage you have already
                          granted from it is unaffected — the ledger is
                          append-only.
                        </>
                      }
                      confirmText={nodeLabel(name, row.record.node_id)}
                      confirmLabel="Release"
                      pendingLabel="Releasing..."
                      onConfirm={() => release(row)}
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm text-muted-foreground">
                  Usable <strong>{formatStorage(row.usableGb)}</strong> ·
                  granted <strong>{formatStorage(row.claimedGb)}</strong> · free{' '}
                  <strong>{formatStorage(freeGb)}</strong>
                </p>

                {row.claims.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing granted from this node yet.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Entry</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>Note</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {row.claims.map((claim) => (
                        <TableRow key={claim.id}>
                          <TableCell className="font-mono text-xs">
                            {claim.user}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatStorage(claim.quota_gb)}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {claim.note || '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          );
        })
      )}

      {grantFor && (
        <SetClaimDialog
          open
          onOpenChange={(open) => {
            if (!open) setGrantFor(null);
          }}
          // No `userId`: a node owner cannot resolve another user's PB id, so
          // the address goes to the server to resolve as a superuser.
          userEmail=""
          nodeId={grantFor.nodeId}
          nodeName={grantFor.nodeName}
          currentGb={0}
          nodeFreeGb={grantFor.freeGb}
          onApplied={refresh}
        />
      )}
    </div>
  );
}

export default function NodesPage() {
  return (
    <ProtectedRoute>
      <NodesView />
    </ProtectedRoute>
  );
}
