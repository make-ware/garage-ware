'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
import { api } from '@/lib/api-client';
import {
  formatPbDateTime,
  formatSignedStorage,
  formatStorage,
} from '@/lib/format';
import type { AdminUser, LayoutResponse } from '@/lib/admin-types';
import {
  CLAIM_AUDIT_ACTIONS,
  type ClaimAuditAction,
  type StorageClaimAudit,
} from '@garage-ware/shared';

const PER_PAGE = 50;
const ANY = '__any__';

interface AuditResponse {
  items: StorageClaimAudit[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
}

function AdminLedgerView() {
  const params = useSearchParams();

  const [userFilter, setUserFilter] = useState(params.get('userId') ?? ANY);
  const [nodeFilter, setNodeFilter] = useState(params.get('nodeId') ?? ANY);
  const [actionFilter, setActionFilter] = useState(params.get('action') ?? ANY);
  const [page, setPage] = useState(1);

  const [data, setData] = useState<AuditResponse | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [layout, setLayout] = useState<LayoutResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  const query = useMemo(() => {
    const q = new URLSearchParams({
      page: String(page),
      perPage: String(PER_PAGE),
    });
    if (userFilter !== ANY) q.set('userId', userFilter);
    if (nodeFilter !== ANY) q.set('nodeId', nodeFilter);
    if (actionFilter !== ANY) q.set('action', actionFilter);
    return q.toString();
  }, [page, userFilter, nodeFilter, actionFilter]);

  // Filters and page live in state, so the effect re-runs on every change and
  // is the only place that fetches — there is no separate refresh() to drift.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const resp = await api<AuditResponse>(
          `/next-api/garage/claim-audit?${query}`
        );
        if (cancelled) return;
        setData(resp);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const [usersResp, layoutResp] = await Promise.all([
          api<{ items: AdminUser[] }>('/next-api/garage/users'),
          api<LayoutResponse>('/next-api/garage/cluster/layout'),
        ]);
        if (cancelled) return;
        setUsers(usersResp.items);
        setLayout(layoutResp);
      } catch {
        // Filters degrade to ids without these; the trail itself still renders.
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  const changeFilter = useCallback(
    (setter: (value: string) => void) => (value: string) => {
      setter(value);
      setPage(1);
    },
    []
  );

  const totalPages = data?.totalPages ?? 1;
  const totalItems = data?.totalItems ?? 0;

  async function rebuildBalances() {
    setRebuilding(true);
    try {
      const result = await api<{
        users: number;
        nodes: number;
        corrected: number;
        driftGb: number;
      }>('/next-api/garage/storage-balances/rebuild', { method: 'POST' });
      if (result.corrected > 0) {
        // Not routine maintenance: the incremental hooks are supposed to keep
        // these exact, so anything corrected here is a bug worth chasing.
        toast.warning(
          `Corrected ${result.corrected} balance row(s), net drift ${formatSignedStorage(result.driftGb)} — an incremental hook missed a write path`
        );
      } else {
        toast.success(
          `Balances clean: ${result.users} user(s), ${result.nodes} node balance(s)`
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rebuild failed');
    } finally {
      setRebuilding(false);
    }
  }

  return (
    <div className="p-8 max-w-7xl">
      <div className="mb-2 flex items-start justify-between gap-4">
        <h1 className="text-3xl font-bold">Claim ledger</h1>
        <Button
          variant="outline"
          size="sm"
          disabled={rebuilding}
          onClick={rebuildBalances}
          title="Recompute the storage balance roll-ups from the ledgers and report anything that had to be corrected"
        >
          <RefreshCw
            className={`mr-1 h-4 w-4 ${rebuilding ? 'animate-spin' : ''}`}
          />
          {rebuilding ? 'Rebuilding…' : 'Rebuild balances'}
        </Button>
      </div>
      <p className="text-muted-foreground mb-6">
        Every recorded change to the storage-claim ledger — who changed whose
        grant, when, and by how much. Written by a PocketBase hook rather than
        by the app, so it also captures edits made directly against the database
        and claims removed when a user is deleted. Rows are immutable and
        outlive both the claim and the user they describe.
      </p>

      {error && <p className="text-destructive mb-4">{error}</p>}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
            <div className="space-y-2">
              <Label>User</Label>
              <Select
                value={userFilter}
                onValueChange={changeFilter(setUserFilter)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Any user" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any user</SelectItem>
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
              <Select
                value={nodeFilter}
                onValueChange={changeFilter(setNodeFilter)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Any node" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any node</SelectItem>
                  {layout?.roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.id.slice(0, 12)}… ({r.zone})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Action</Label>
              <Select
                value={actionFilter}
                onValueChange={changeFilter(setActionFilter)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Any action" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any action</SelectItem>
                  {CLAIM_AUDIT_ACTIONS.map((a: ClaimAuditAction) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                setUserFilter(ANY);
                setNodeFilter(ANY);
                setActionFilter(ANY);
                setPage(1);
              }}
            >
              Clear filters
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audit trail</CardTitle>
          <CardDescription>
            {totalItems} entr{totalItems === 1 ? 'y' : 'ies'}
            {totalPages > 1 && ` — page ${data?.page ?? page} of ${totalPages}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : !data || data.items.length === 0 ? (
            <p className="text-muted-foreground">
              Nothing recorded for these filters.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead>Node</TableHead>
                      <TableHead className="text-right">Change</TableHead>
                      <TableHead className="text-right">
                        Previous → New
                      </TableHead>
                      <TableHead>By</TableHead>
                      <TableHead>Note</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((entry) => {
                      const delta = Number(entry.delta_gb) || 0;
                      const user = userById.get(entry.user_id);
                      return (
                        <TableRow key={entry.id}>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            {formatPbDateTime(entry.created)}
                          </TableCell>
                          <TableCell>
                            {entry.action}
                            {entry.source === 'cascade' && (
                              <span
                                className="ml-1 text-xs text-muted-foreground"
                                title="Removed as a side effect of deleting the owning user"
                              >
                                (cascade)
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            {/* The user may since have been deleted — fall back
                                to the email snapshotted at the time. */}
                            {user ? (
                              <Link
                                href={`/admin/claims?userId=${entry.user_id}`}
                                className="underline"
                              >
                                {user.email}
                              </Link>
                            ) : (
                              <span
                                className="text-muted-foreground"
                                title="This user no longer exists"
                              >
                                {entry.user_email || entry.user_id}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {entry.node_hostname ||
                              `${entry.node_id.slice(0, 12)}…`}
                          </TableCell>
                          <TableCell
                            className={`text-right font-mono whitespace-nowrap ${
                              delta < 0 ? 'text-destructive' : 'text-foreground'
                            }`}
                          >
                            {formatSignedStorage(delta)}
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap text-muted-foreground text-xs">
                            {formatStorage(Number(entry.previous_gb) || 0)} →{' '}
                            {formatStorage(Number(entry.new_gb) || 0)}
                          </TableCell>
                          <TableCell className="text-xs">
                            {entry.actor_email || '—'}
                            {entry.actor_type &&
                              entry.actor_type !== 'user' && (
                                <span className="ml-1 text-muted-foreground">
                                  ({entry.actor_type})
                                </span>
                              )}
                          </TableCell>
                          <TableCell className="text-muted-foreground max-w-[200px] truncate">
                            {entry.note || '—'}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {totalPages > 1 && (
                <div className="mt-4 flex items-center justify-between">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(p - 1, 1))}
                  >
                    <ChevronLeft className="mr-1 h-4 w-4" /> Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {data.page} of {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
                  >
                    Next <ChevronRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminLedgerPage() {
  return (
    <Suspense fallback={<div className="p-8">Loading...</div>}>
      <AdminLedgerView />
    </Suspense>
  );
}
