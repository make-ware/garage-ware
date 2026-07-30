'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
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
import { formatStorage } from '@/lib/format';
import { bytesToGib } from '@/lib/storage/units';
import type { StorageClaim } from '@garage-ware/shared';
import type { ClusterLayout } from '@/lib/garage';

interface AdminUser {
  id: string;
  email: string;
  name?: string;
  granted_gb: number;
}

interface LayoutResponse extends ClusterLayout {
  replicationFactor: number;
}

/** One (user, node) pair rolled up from its ledger entries. */
interface ClaimGroup {
  key: string;
  userId: string;
  nodeId: string;
  nodeHostname?: string;
  nodeZone?: string;
  effectiveGb: number;
  /** Newest first. */
  entries: StorageClaim[];
}

/** Render a signed ledger amount, e.g. "+2 TB" / "-500 GB". */
function formatSigned(gib: number): string {
  const magnitude = formatStorage(Math.abs(gib));
  return `${gib < 0 ? '-' : '+'}${magnitude}`;
}

function formatEntryDate(value: string | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
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

  const [formUser, setFormUser] = useState<string>('');
  const [formNode, setFormNode] = useState<string>('');
  const [formQuotaGib, setFormQuotaGib] = useState<number>(0);
  const [formNote, setFormNote] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  async function refresh() {
    const [claimsResp, usersResp, layoutResp] = await Promise.all([
      api<{ items: StorageClaim[] }>('/next-api/garage/claims?all=true'),
      api<{ items: AdminUser[] }>('/next-api/garage/users'),
      api<LayoutResponse>('/next-api/garage/cluster/layout'),
    ]);
    setClaims(claimsResp.items);
    setUsers(usersResp.items);
    setLayout(layoutResp);
  }

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [claimsResp, usersResp, layoutResp] = await Promise.all([
          api<{ items: StorageClaim[] }>('/next-api/garage/claims?all=true'),
          api<{ items: AdminUser[] }>('/next-api/garage/users'),
          api<LayoutResponse>('/next-api/garage/cluster/layout'),
        ]);
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
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  const claimsByNode = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of claims) {
      map.set(c.node_id, (map.get(c.node_id) ?? 0) + (Number(c.quota_gb) || 0));
    }
    return map;
  }, [claims]);

  /** Effective claim per (user, node) — the ledger sum for that pair. */
  const effectiveByUserNode = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of claims) {
      const key = `${c.user}::${c.node_id}`;
      map.set(key, (map.get(key) ?? 0) + (Number(c.quota_gb) || 0));
    }
    return map;
  }, [claims]);

  const groups = useMemo<ClaimGroup[]>(() => {
    const map = new Map<string, ClaimGroup>();
    for (const c of claims) {
      const key = `${c.user}::${c.node_id}`;
      let group = map.get(key);
      if (!group) {
        group = {
          key,
          userId: c.user,
          nodeId: c.node_id,
          nodeHostname: c.node_hostname,
          nodeZone: c.node_zone,
          effectiveGb: 0,
          entries: [],
        };
        map.set(key, group);
      }
      group.effectiveGb += Number(c.quota_gb) || 0;
      group.entries.push(c);
      // The newest entry carries the freshest node metadata.
      group.nodeHostname ??= c.node_hostname;
      group.nodeZone ??= c.node_zone;
    }
    const list = [...map.values()];
    for (const group of list) {
      group.entries.sort((a, b) => (a.created < b.created ? 1 : -1));
    }
    return list.sort((a, b) => {
      const aEmail = userById.get(a.userId)?.email ?? a.userId;
      const bEmail = userById.get(b.userId)?.email ?? b.userId;
      return (
        aEmail.localeCompare(bEmail) ||
        (a.nodeHostname ?? a.nodeId).localeCompare(b.nodeHostname ?? b.nodeId)
      );
    });
  }, [claims, userById]);

  const visibleGroups = useMemo(
    () =>
      filterUserId ? groups.filter((g) => g.userId === filterUserId) : groups,
    [groups, filterUserId]
  );

  const selectedRole = layout?.roles.find((r) => r.id === formNode);
  const selectedNodeUsableGb =
    selectedRole?.capacity && layout
      ? bytesToGib(selectedRole.capacity) /
        Math.max(layout.replicationFactor, 1)
      : 0;
  const selectedNodeAllocatedGb = formNode
    ? (claimsByNode.get(formNode) ?? 0)
    : 0;
  const selectedNodeFreeGb = Math.max(
    selectedNodeUsableGb - selectedNodeAllocatedGb,
    0
  );
  const selectedPairEffectiveGb =
    formUser && formNode
      ? (effectiveByUserNode.get(`${formUser}::${formNode}`) ?? 0)
      : 0;

  // Seed the amount field: for a fresh (user, node) pair offer the node's
  // remaining free space; for an existing claim start blank so the admin types
  // the adjustment rather than the new total.
  useEffect(() => {
    if (!formNode) return;
    const hasExisting =
      formUser && effectiveByUserNode.has(`${formUser}::${formNode}`);
    if (hasExisting) {
      setFormQuotaGib(0);
      return;
    }
    const role = layout?.roles.find((r) => r.id === formNode);
    const usableGb =
      role?.capacity && layout
        ? bytesToGib(role.capacity) / Math.max(layout.replicationFactor, 1)
        : 0;
    const allocatedGb = claimsByNode.get(formNode) ?? 0;
    setFormQuotaGib(Math.max(usableGb - allocatedGb, 0));
  }, [formUser, formNode, layout, claimsByNode, effectiveByUserNode]);

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
        `Claim adjusted by ${formatSigned(formQuotaGib)} — now ${formatStorage(
          selectedPairEffectiveGb + formQuotaGib
        )}`
      );
      setFormQuotaGib(0);
      setFormNote('');
      setExpanded((prev) => new Set(prev).add(`${formUser}::${formNode}`));
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
            disk — or a negative amount to reclaim. The sum of all claims on a
            node stays capped at its usable capacity, and a user&apos;s claim on
            a node can never go below zero.
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
            ledger history
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleGroups.map((group) => {
                  const user = userById.get(group.userId);
                  const present = layout?.roles.some(
                    (r) => r.id === group.nodeId
                  );
                  const isOpen = expanded.has(group.key);
                  return [
                    <TableRow key={group.key}>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0"
                          aria-expanded={isOpen}
                          aria-label={
                            isOpen
                              ? 'Hide ledger history'
                              : 'Show ledger history'
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
                        {group.nodeHostname || group.nodeId.slice(0, 12) + '…'}
                        {!present && (
                          <span className="ml-2 text-destructive">
                            (not in layout)
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{group.nodeZone || '—'}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatStorage(group.effectiveGb)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {group.entries.length}
                      </TableCell>
                    </TableRow>,
                    isOpen && (
                      <TableRow
                        key={`${group.key}-history`}
                        className="hover:bg-transparent"
                      >
                        <TableCell />
                        <TableCell colSpan={5} className="py-0">
                          <div className="my-2 rounded-md border bg-muted/30">
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
                                        {formatEntryDate(entry.created)}
                                      </td>
                                      <td
                                        className={`px-3 py-2 text-right font-mono whitespace-nowrap ${
                                          amount < 0
                                            ? 'text-destructive'
                                            : 'text-foreground'
                                        }`}
                                      >
                                        {formatSigned(amount)}
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
                                                {formatSigned(amount)} entry
                                                from {user?.email ?? 'the user'}
                                                &apos;s ledger on this node,
                                                leaving{' '}
                                                {formatStorage(
                                                  group.effectiveGb - amount
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
