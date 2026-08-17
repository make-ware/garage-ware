'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { NodeIdentity } from '@/components/cluster/node-identity';
import { api } from '@/lib/api-client';
import { formatStorage } from '@/lib/format';
import { nodeLabel, parseNodeTags } from '@/lib/node-label';
import { nodeUsableGbFrom } from '@/lib/storage/ledger-math';
import type { NodeOwner } from '@garage-ware/shared';
import type { ClusterNodeItem, ClusterNodesResponse } from '@/lib/types';

/**
 * Node ownership, from the admin side.
 *
 * Every node in the layout with its owner, or "Unowned". Assigning here is the
 * same POST a user makes with `user_id` set, which only an admin may send;
 * revoking is the same DELETE the owner would make on their own row.
 *
 * Ownership never moves storage. The claim ledger is append-only and its
 * entries record what was granted, not who was entitled to grant it — so
 * revoking a node leaves every claim sourced from it exactly where it was.
 */

interface UserOption {
  id: string;
  email?: string;
}

interface NodeRow {
  node: ClusterNodeItem;
  owner: NodeOwner | null;
  usableGb: number;
}

export default function AdminNodesPage() {
  const [rows, setRows] = useState<NodeRow[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [assignTo, setAssignTo] = useState<Record<string, string>>({});

  async function load(): Promise<{ rows: NodeRow[]; users: UserOption[] }> {
    const [nodesResp, ownersResp, usersResp] = await Promise.all([
      api<ClusterNodesResponse>('/next-api/garage/cluster/nodes'),
      api<{ items: NodeOwner[] }>('/next-api/garage/nodes/owners?all=true'),
      api<{ items: UserOption[] }>('/next-api/garage/users'),
    ]);
    const ownerByNode = new Map(
      ownersResp.items.map((o) => [o.node_id, o] as const)
    );
    const rf = nodesResp.replicationFactor;
    return {
      rows: nodesResp.items.map((node) => ({
        node,
        owner: ownerByNode.get(node.id) ?? null,
        // The one implementation of capacity / replicationFactor, shared with
        // the dashboard and the claim guard. It clamps the RF, so an unreadable
        // one cannot make a node look bigger than it is.
        usableGb: nodeUsableGbFrom(node.capacity, rf) ?? 0,
      })),
      users: usersResp.items,
    };
  }

  async function refresh() {
    const next = await load();
    setRows(next.rows);
    setUsers(next.users);
  }

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const next = await load();
        if (cancelled) return;
        setRows(next.rows);
        setUsers(next.users);
      } catch (err) {
        if (!cancelled)
          toast.error(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  const emailFor = (userId: string) =>
    users.find((u) => u.id === userId)?.email ?? userId;

  async function assign(nodeId: string) {
    const userId = assignTo[nodeId];
    if (!userId) return;
    try {
      await api('/next-api/garage/nodes/owners', {
        method: 'POST',
        body: { node_id: nodeId, user_id: userId },
      });
      toast.success(`Assigned to ${emailFor(userId)}`);
      setAssignTo((prev) => ({ ...prev, [nodeId]: '' }));
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Assign failed');
    }
  }

  async function revoke(owner: NodeOwner) {
    await api(`/next-api/garage/nodes/owners/${owner.id}`, {
      method: 'DELETE',
    });
    toast.success('Ownership revoked');
    await refresh();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Node ownership</CardTitle>
          <CardDescription>
            An owner may grant storage sourced from their node to anyone, up to
            the node&apos;s usable capacity. Ownership does not raise that
            ceiling, and revoking it leaves existing claims untouched.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Node</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead className="text-right">Usable</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ node, owner, usableGb }) => {
                  const name = parseNodeTags(node.tags).name;
                  return (
                    <TableRow key={node.id}>
                      <TableCell>
                        <NodeIdentity name={name} nodeId={node.id} />
                      </TableCell>
                      <TableCell>{node.zone}</TableCell>
                      <TableCell className="text-right">
                        {formatStorage(usableGb)}
                      </TableCell>
                      <TableCell>
                        {owner ? (
                          emailFor(owner.user)
                        ) : (
                          <Badge variant="outline">Unowned</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {owner ? (
                          <ConfirmDeleteDialog
                            trigger={
                              <Button size="sm" variant="outline">
                                Revoke
                              </Button>
                            }
                            title="Revoke node ownership"
                            description={
                              <>
                                <strong>{emailFor(owner.user)}</strong> will no
                                longer be able to grant storage from{' '}
                                <strong>{nodeLabel(name, node.id)}</strong>.
                                Claims already made from it are unaffected.
                              </>
                            }
                            confirmText={nodeLabel(name, node.id)}
                            confirmLabel="Revoke"
                            pendingLabel="Revoking..."
                            onConfirm={() => revoke(owner)}
                          />
                        ) : (
                          <div className="flex justify-end gap-2">
                            <Select
                              value={assignTo[node.id] ?? ''}
                              onValueChange={(v) =>
                                setAssignTo((prev) => ({
                                  ...prev,
                                  [node.id]: v,
                                }))
                              }
                            >
                              <SelectTrigger className="w-56">
                                <SelectValue placeholder="Assign to…" />
                              </SelectTrigger>
                              <SelectContent>
                                {users.map((u) => (
                                  <SelectItem key={u.id} value={u.id}>
                                    {u.email ?? u.id}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              size="sm"
                              disabled={!assignTo[node.id]}
                              onClick={() => assign(node.id)}
                            >
                              Assign
                            </Button>
                          </div>
                        )}
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
