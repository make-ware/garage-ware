'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { SetClaimDialog } from '@/components/admin/set-claim-dialog';
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
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { api } from '@/lib/api-client';
import { formatPbDate, formatSignedStorage, formatStorage } from '@/lib/format';
import type { AdminUser, LayoutResponse } from '@/lib/admin-types';
import {
  nodeUsableGbInLayout,
  rollUpClaimsByUserNode,
  sumClaimsByNode,
  sumClaimsByUserNode,
  userNodeKey,
  type UserNodeClaimRollup,
} from '@/lib/storage/ledger-math';
import type { StorageClaim, StorageClaimAudit } from '@garage-ware/shared';

/** Row targeted by the "Set claim" dialog. */
interface SetClaimTarget {
  group: UserNodeClaimRollup;
  userEmail: string;
  nodeLabel: string;
  nodeFreeGb: number;
}

function nodeLabelFor(group: {
  nodeHostname?: string;
  nodeId: string;
}): string {
  return group.nodeHostname || `${group.nodeId.slice(0, 12)}…`;
}

function AdminClaimsView() {
  const params = useSearchParams();
  const filterUserId = params.get('userId');

  const [claims, setClaims] = useState<StorageClaim[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [layout, setLayout] = useState<LayoutResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [auditByKey, setAuditByKey] = useState<
    Map<string, StorageClaimAudit[]>
  >(new Map());
  const [setClaimTarget, setSetClaimTarget] = useState<SetClaimTarget | null>(
    null
  );

  const [formUser, setFormUser] = useState<string>('');
  const [formNode, setFormNode] = useState<string>('');
  const [formQuotaGib, setFormQuotaGib] = useState<number>(0);
  const [formNote, setFormNote] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const [claimsResp, usersResp, layoutResp] = await Promise.all([
      api<{ items: StorageClaim[] }>('/next-api/garage/claims?all=true'),
      api<{ items: AdminUser[] }>('/next-api/garage/users'),
      api<LayoutResponse>('/next-api/garage/cluster/layout'),
    ]);
    return { claimsResp, usersResp, layoutResp };
  }, []);

  const refresh = useCallback(async () => {
    const { claimsResp, usersResp, layoutResp } = await load();
    setClaims(claimsResp.items);
    setUsers(usersResp.items);
    setLayout(layoutResp);
    // Audit rows are fetched per expanded row; drop the cache so a reopened
    // row shows the entry that was just written rather than a stale list.
    setAuditByKey(new Map());
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const { claimsResp, usersResp, layoutResp } = await load();
        if (cancelled) return;
        setClaims(claimsResp.items);
        setUsers(usersResp.items);
        setLayout(layoutResp);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  /** Total claimed per node across all users — drives the free-capacity hints. */
  const claimsByNode = useMemo(() => sumClaimsByNode(claims), [claims]);

  /** Effective claim per (user, node) pair. */
  const effectiveByUserNode = useMemo(
    () => sumClaimsByUserNode(claims),
    [claims]
  );

  const groups = useMemo(() => {
    const list = rollUpClaimsByUserNode(claims, layout ?? undefined);
    return list.sort((a, b) => {
      const aEmail = userById.get(a.userId)?.email ?? a.userId;
      const bEmail = userById.get(b.userId)?.email ?? b.userId;
      return (
        aEmail.localeCompare(bEmail) ||
        nodeLabelFor(a).localeCompare(nodeLabelFor(b))
      );
    });
  }, [claims, layout, userById]);

  const visibleGroups = useMemo(
    () =>
      filterUserId ? groups.filter((g) => g.userId === filterUserId) : groups,
    [groups, filterUserId]
  );

  const replicationFactor = layout?.replicationFactor ?? 1;

  const nodeFreeGbFor = useCallback(
    (nodeId: string) => {
      const usableGb =
        nodeUsableGbInLayout(layout, nodeId, replicationFactor) ?? 0;
      return Math.max(usableGb - (claimsByNode.get(nodeId) ?? 0), 0);
    },
    [layout, replicationFactor, claimsByNode]
  );

  const selectedNodeUsableGb = formNode
    ? (nodeUsableGbInLayout(layout, formNode, replicationFactor) ?? 0)
    : 0;
  const selectedNodeAllocatedGb = formNode
    ? (claimsByNode.get(formNode) ?? 0)
    : 0;
  const selectedNodeFreeGb = formNode ? nodeFreeGbFor(formNode) : 0;
  const selectedPairEffectiveGb =
    formUser && formNode
      ? (effectiveByUserNode.get(userNodeKey(formUser, formNode)) ?? 0)
      : 0;

  // Seed the amount field: for a fresh (user, node) pair offer the node's
  // remaining free space; for an existing claim start blank so the admin types
  // the adjustment rather than the new total.
  useEffect(() => {
    if (!formNode) return;
    const hasExisting =
      formUser && effectiveByUserNode.has(userNodeKey(formUser, formNode));
    if (hasExisting) {
      setFormQuotaGib(0);
      return;
    }
    const usableGb =
      nodeUsableGbInLayout(layout, formNode, replicationFactor) ?? 0;
    const allocatedGb = claimsByNode.get(formNode) ?? 0;
    setFormQuotaGib(Math.max(usableGb - allocatedGb, 0));
  }, [
    formUser,
    formNode,
    layout,
    replicationFactor,
    claimsByNode,
    effectiveByUserNode,
  ]);

  // Load a row's audit trail the first time it is expanded. Cheap per row, and
  // the alternative — fetching the whole trail up front — scales with cluster
  // history rather than with what the admin is looking at.
  useEffect(() => {
    let cancelled = false;
    const missing = [...expanded].filter((key) => !auditByKey.has(key));
    if (missing.length === 0) return;

    const run = async () => {
      const fetched = await Promise.all(
        missing.map(async (key) => {
          const [userId, nodeId] = key.split('::');
          try {
            const resp = await api<{ items: StorageClaimAudit[] }>(
              `/next-api/garage/claim-audit?userId=${encodeURIComponent(userId)}&nodeId=${encodeURIComponent(nodeId)}&perPage=200`
            );
            return [key, resp.items] as const;
          } catch {
            // A failed audit fetch must not blank out the ledger rows next to
            // it; show the row with an empty trail instead.
            return [key, [] as StorageClaimAudit[]] as const;
          }
        })
      );
      if (cancelled) return;
      setAuditByKey((prev) => {
        const next = new Map(prev);
        for (const [key, items] of fetched) next.set(key, items);
        return next;
      });
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [expanded, auditByKey]);

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!formUser || !formNode) {
      toast.error('Pick a user and a node');
      return;
    }
    if (!Number.isFinite(formQuotaGib) || formQuotaGib === 0) {
      toast.error('Adjustment must be a non-zero amount');
      return;
    }
    setSubmitting(true);
    try {
      await api('/next-api/garage/claims', {
        method: 'POST',
        body: {
          user_id: formUser,
          node_id: formNode,
          quota_gb: formQuotaGib,
          ...(formNote.trim() ? { note: formNote.trim() } : {}),
        },
      });
      toast.success(
        `Claim adjusted by ${formatSignedStorage(formQuotaGib)} — now ${formatStorage(
          selectedPairEffectiveGb + formQuotaGib
        )}`
      );
      setFormQuotaGib(0);
      setFormNote('');
      setExpanded((prev) => new Set(prev).add(userNodeKey(formUser, formNode)));
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Adjustment failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function removeEntry(entry: StorageClaim) {
    await api(`/next-api/garage/claims/${entry.id}`, { method: 'DELETE' });
    toast.success('Ledger entry removed');
    await refresh();
  }

  return (
    <div className="p-8 max-w-6xl">
      <h1 className="text-3xl font-bold mb-2">Storage claims</h1>
      <p className="text-muted-foreground mb-6">
        Grant users storage on specific cluster nodes. Claims are an append-only
        ledger: each adjustment is its own entry, and a user&apos;s effective
        claim on a node is the sum of its entries. Their total across nodes caps
        how much they can allocate to buckets.
      </p>

      {filterUserId && (
        <p className="text-sm mb-4">
          Filtering by user{' '}
          <strong>{userById.get(filterUserId)?.email ?? filterUserId}</strong> —{' '}
          <Link href="/admin/claims" className="underline">
            show all
          </Link>
        </p>
      )}

      {error && <p className="text-destructive mb-4">{error}</p>}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Adjust claim</CardTitle>
          <CardDescription>
            Per-node accounting in logical (post-replication) GB. Enter a
            positive amount to grant more — e.g. after upgrading the node&apos;s
            disk — or a negative amount to reclaim. To restate a user&apos;s
            total rather than the change, use <strong>Set claim</strong> on
            their row below. The sum of all claims on a node stays capped at its
            usable capacity, and a user&apos;s claim on a node can never go
            below zero.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
              <div className="space-y-2">
                <Label>User</Label>
                <Select value={formUser} onValueChange={setFormUser}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Pick a user" />
                  </SelectTrigger>
                  <SelectContent>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Node</Label>
                <Select value={formNode} onValueChange={setFormNode}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Pick a node" />
                  </SelectTrigger>
                  <SelectContent>
                    {layout?.roles.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.id.slice(0, 12)}… ({r.zone})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="claim-quota">Adjustment</Label>
                <StorageQuotaInput
                  id="claim-quota"
                  valueGib={formQuotaGib}
                  onChangeGib={setFormQuotaGib}
                  minGib={-selectedPairEffectiveGb}
                  maxGib={selectedNodeFreeGb}
                />
              </div>
              <Button type="submit" disabled={submitting}>
                <Plus className="mr-1 h-4 w-4" />
                {submitting ? 'Applying...' : 'Apply adjustment'}
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="claim-note">Note (optional)</Label>
              <Input
                id="claim-note"
                value={formNote}
                onChange={(e) => setFormNote(e.target.value)}
                placeholder="e.g. upgraded to 8TB disk"
                maxLength={500}
              />
            </div>
            {formNode && (
              <p className="text-xs text-muted-foreground">
                Node usable:{' '}
                <strong>{formatStorage(selectedNodeUsableGb)}</strong> ·
                claimed:{' '}
                <strong>{formatStorage(selectedNodeAllocatedGb)}</strong> · free
                to grant: <strong>{formatStorage(selectedNodeFreeGb)}</strong>
                {formUser && (
                  <>
                    {' '}
                    · this user&apos;s claim here:{' '}
                    <strong>{formatStorage(selectedPairEffectiveGb)}</strong>
                    {formQuotaGib !== 0 && (
                      <>
                        {' '}
                        →{' '}
                        <strong>
                          {formatStorage(
                            selectedPairEffectiveGb + formQuotaGib
                          )}
                        </strong>
                      </>
                    )}
                  </>
                )}
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All claims</CardTitle>
          <CardDescription>
            {visibleGroups.length} claim
            {visibleGroups.length === 1 ? '' : 's'} — expand a row to see its
            ledger history and audit trail. Claims on nodes that have left the
            layout are shown struck through: they back nothing, and do not count
            toward the user&apos;s granted total.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : visibleGroups.length === 0 ? (
            <p className="text-muted-foreground">No claims yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>User</TableHead>
                  <TableHead>Node</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead className="text-right">Claim</TableHead>
                  <TableHead className="text-right">Entries</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleGroups.map((group) => {
                  const user = userById.get(group.userId);
                  const isOpen = expanded.has(group.key);
                  const auditEntries = auditByKey.get(group.key);
                  const nodeLabel = nodeLabelFor(group);
                  return [
                    <TableRow key={group.key}>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0"
                          aria-expanded={isOpen}
                          aria-label={
                            isOpen ? 'Hide claim history' : 'Show claim history'
                          }
                          onClick={() => toggleExpanded(group.key)}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                      <TableCell>{user?.email ?? group.userId}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {nodeLabel}
                        {!group.presentInLayout && (
                          <span className="ml-2 text-destructive">
                            (not in layout)
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{group.nodeZone || '—'}</TableCell>
                      <TableCell
                        className={`text-right font-medium ${
                          group.presentInLayout
                            ? ''
                            : 'text-muted-foreground line-through'
                        }`}
                        title={
                          group.presentInLayout
                            ? undefined
                            : 'This node has left the layout, so the claim counts as 0 toward the user’s granted total'
                        }
                      >
                        {formatStorage(group.claimedGb)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {group.entries.length}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7"
                          disabled={!group.presentInLayout}
                          title={
                            group.presentInLayout
                              ? undefined
                              : 'A claim on a node that has left the layout can only be wound down'
                          }
                          onClick={() =>
                            setSetClaimTarget({
                              group,
                              userEmail: user?.email ?? group.userId,
                              nodeLabel,
                              nodeFreeGb: nodeFreeGbFor(group.nodeId),
                            })
                          }
                        >
                          <Pencil className="mr-1 h-3.5 w-3.5" />
                          Set claim
                        </Button>
                      </TableCell>
                    </TableRow>,
                    isOpen && (
                      <TableRow
                        key={`${group.key}-history`}
                        className="hover:bg-transparent"
                      >
                        <TableCell />
                        <TableCell colSpan={6} className="py-0">
                          <div className="my-2 rounded-md border bg-muted/30">
                            <p className="px-3 pt-2 text-xs font-medium text-muted-foreground">
                              Current ledger entries
                            </p>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-muted-foreground border-b">
                                  <th className="text-left font-medium px-3 py-2">
                                    Date
                                  </th>
                                  <th className="text-right font-medium px-3 py-2">
                                    Amount
                                  </th>
                                  <th className="text-left font-medium px-3 py-2">
                                    Note
                                  </th>
                                  <th className="w-10 px-3 py-2" />
                                </tr>
                              </thead>
                              <tbody>
                                {group.entries.map((entry) => {
                                  const amount = Number(entry.quota_gb) || 0;
                                  return (
                                    <tr
                                      key={entry.id}
                                      className="border-b last:border-0"
                                    >
                                      <td className="px-3 py-2 whitespace-nowrap">
                                        {formatPbDate(entry.created)}
                                      </td>
                                      <td
                                        className={`px-3 py-2 text-right font-mono whitespace-nowrap ${
                                          amount < 0
                                            ? 'text-destructive'
                                            : 'text-foreground'
                                        }`}
                                      >
                                        {formatSignedStorage(amount)}
                                      </td>
                                      <td className="px-3 py-2 text-muted-foreground">
                                        {entry.note || '—'}
                                      </td>
                                      <td className="px-3 py-2 text-right">
                                        <ConfirmDeleteDialog
                                          trigger={
                                            <Button
                                              size="sm"
                                              variant="ghost"
                                              className="h-6 w-6 p-0"
                                              aria-label="Remove ledger entry"
                                            >
                                              <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                          }
                                          title="Remove ledger entry"
                                          description={
                                            <>
                                              <p>
                                                Deletes the{' '}
                                                {formatSignedStorage(amount)}{' '}
                                                entry from{' '}
                                                {user?.email ?? 'the user'}
                                                &apos;s ledger on this node,
                                                leaving{' '}
                                                {formatStorage(
                                                  group.claimedGb - amount
                                                )}
                                                . This will fail if their
                                                buckets already exceed what
                                                would remain.
                                              </p>
                                              <p>
                                                Prefer appending a negative
                                                adjustment instead — it reclaims
                                                the space while keeping the
                                                history intact.
                                              </p>
                                            </>
                                          }
                                          confirmText={
                                            user?.email ?? group.userId
                                          }
                                          confirmLabel="Remove entry"
                                          onConfirm={() => removeEntry(entry)}
                                        />
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>

                            <p className="px-3 pt-3 text-xs font-medium text-muted-foreground">
                              Audit trail
                            </p>
                            <p className="px-3 pb-1 text-[11px] text-muted-foreground">
                              Every recorded change, including entries that have
                              since been edited or deleted.
                            </p>
                            {auditEntries === undefined ? (
                              <p className="px-3 pb-3 text-xs text-muted-foreground">
                                Loading...
                              </p>
                            ) : auditEntries.length === 0 ? (
                              <p className="px-3 pb-3 text-xs text-muted-foreground">
                                Nothing recorded yet.
                              </p>
                            ) : (
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-muted-foreground border-b">
                                    <th className="text-left font-medium px-3 py-2">
                                      Date
                                    </th>
                                    <th className="text-left font-medium px-3 py-2">
                                      Action
                                    </th>
                                    <th className="text-right font-medium px-3 py-2">
                                      Change
                                    </th>
                                    <th className="text-left font-medium px-3 py-2">
                                      By
                                    </th>
                                    <th className="text-left font-medium px-3 py-2">
                                      Note
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {auditEntries.map((entry) => {
                                    const delta = Number(entry.delta_gb) || 0;
                                    return (
                                      <tr
                                        key={entry.id}
                                        className="border-b last:border-0"
                                      >
                                        <td className="px-3 py-2 whitespace-nowrap">
                                          {formatPbDate(entry.created)}
                                        </td>
                                        <td className="px-3 py-2">
                                          {entry.action}
                                          {entry.source === 'cascade' && (
                                            <span className="ml-1 text-muted-foreground">
                                              (user deleted)
                                            </span>
                                          )}
                                        </td>
                                        <td
                                          className={`px-3 py-2 text-right font-mono whitespace-nowrap ${
                                            delta < 0
                                              ? 'text-destructive'
                                              : 'text-foreground'
                                          }`}
                                        >
                                          {formatSignedStorage(delta)}
                                          <span className="ml-1 text-muted-foreground">
                                            (
                                            {formatStorage(
                                              Number(entry.previous_gb) || 0
                                            )}{' '}
                                            →{' '}
                                            {formatStorage(
                                              Number(entry.new_gb) || 0
                                            )}
                                            )
                                          </span>
                                        </td>
                                        <td className="px-3 py-2 text-muted-foreground">
                                          {entry.actor_email ||
                                            entry.actor_type ||
                                            '—'}
                                        </td>
                                        <td className="px-3 py-2 text-muted-foreground">
                                          {entry.note || '—'}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ),
                  ];
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {setClaimTarget && (
        <SetClaimDialog
          open
          onOpenChange={(open) => {
            if (!open) setSetClaimTarget(null);
          }}
          userId={setClaimTarget.group.userId}
          userEmail={setClaimTarget.userEmail}
          nodeId={setClaimTarget.group.nodeId}
          nodeLabel={setClaimTarget.nodeLabel}
          currentGb={setClaimTarget.group.claimedGb}
          nodeFreeGb={setClaimTarget.nodeFreeGb}
          onApplied={refresh}
        />
      )}
    </div>
  );
}

export default function AdminClaimsPage() {
  return (
    <Suspense fallback={<div className="p-8">Loading...</div>}>
      <AdminClaimsView />
    </Suspense>
  );
}
