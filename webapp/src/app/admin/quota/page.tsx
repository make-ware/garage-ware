'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { OtpVerificationDialog } from '@/components/auth/otp-gated-dialog';
import { ChangeBucketQuotaDialog } from '@/components/admin/change-bucket-quota-dialog';
import { QuotaFillPct } from '@/components/storage/quota-fill';
import { api } from '@/lib/api-client';
import { formatBytes, formatStorage } from '@/lib/format';
import { gibToBytes } from '@/lib/storage/units';
import type { AdminUser } from '@/lib/admin-types';
import type {
  QuotaAuditResponse,
  QuotaAuditRow,
} from '@/app/next-api/garage/buckets/quota-audit/route';

type Direction = 'adopt-garage' | 'push-pb';

interface UserQuotaGroup {
  userId: string;
  email: string;
  /** Null when the user fell past the 200-row page `/users` serves. */
  position: AdminUser | null;
  rows: QuotaAuditRow[];
  allocatedGb: number;
  usedBytes: number;
  objects: number;
  driftedCount: number;
  unknownCount: number;
}

export default function AdminQuotaPage() {
  const [audit, setAudit] = useState<QuotaAuditResponse | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingDirection, setPendingDirection] = useState<Direction | null>(
    null
  );
  const [reconciling, setReconciling] = useState(false);
  const [quotaTarget, setQuotaTarget] = useState<QuotaAuditRow | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch-only, so the mount effect and refresh() each own their setState and
  // neither duplicates the other — the shape /admin/claims already uses.
  const load = useCallback(async () => {
    const [auditResp, usersResp] = await Promise.all([
      api<QuotaAuditResponse>('/next-api/garage/buckets/quota-audit'),
      api<{ items: AdminUser[] }>('/next-api/garage/users'),
    ]);
    return { auditResp, usersResp };
  }, []);

  const apply = useCallback((resp: QuotaAuditResponse, list: AdminUser[]) => {
    setAudit(resp);
    setUsers(list);
    // Re-seed the selection with everything drifted, so the zero-click path
    // still works after a reconcile without resurrecting rows that are now
    // clean or that the admin had deliberately deselected and then fixed.
    setSelected(
      new Set(resp.items.filter((r) => r.status === 'drifted').map((r) => r.id))
    );
  }, []);

  const refresh = useCallback(async () => {
    const { auditResp, usersResp } = await load();
    apply(auditResp, usersResp.items);
  }, [load, apply]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const { auditResp, usersResp } = await load();
        if (cancelled) return;
        apply(auditResp, usersResp.items);
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
  }, [load, apply]);

  const groups = useMemo<UserQuotaGroup[]>(() => {
    if (!audit) return [];
    const userById = new Map(users.map((u) => [u.id, u]));
    const byUser = new Map<string, QuotaAuditRow[]>();
    // Group from the AUDIT rows, not from /users: the audit is the complete
    // list, while /users serves one 200-row page. A user past it must still
    // appear, with their position marked unavailable rather than shown as 0.
    for (const row of audit.items) {
      const list = byUser.get(row.user);
      if (list) list.push(row);
      else byUser.set(row.user, [row]);
    }

    const result: UserQuotaGroup[] = [];
    for (const [userId, rows] of byUser) {
      const position = userById.get(userId) ?? null;
      result.push({
        userId,
        email:
          position?.email ??
          rows.find((r) => r.user_email)?.user_email ??
          userId,
        position,
        rows: [...rows].sort(
          (a, b) =>
            Number(b.status === 'drifted') - Number(a.status === 'drifted') ||
            a.name.localeCompare(b.name)
        ),
        allocatedGb: rows.reduce((s, r) => s + r.pb_quota_gb, 0),
        usedBytes: rows.reduce((s, r) => s + (r.bytes ?? 0), 0),
        objects: rows.reduce((s, r) => s + (r.objects ?? 0), 0),
        driftedCount: rows.filter((r) => r.status === 'drifted').length,
        unknownCount: rows.filter((r) => r.status === 'unknown').length,
      });
    }

    // Drift first — the page exists to surface it, not to make you scroll.
    return result.sort(
      (a, b) =>
        Number(b.driftedCount > 0) - Number(a.driftedCount > 0) ||
        a.email.localeCompare(b.email)
    );
  }, [audit, users]);

  const driftedIds = useMemo(
    () =>
      (audit?.items ?? [])
        .filter((r) => r.status === 'drifted')
        .map((r) => r.id),
    [audit]
  );

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(group: UserQuotaGroup) {
    const ids = group.rows
      .filter((r) => r.status === 'drifted')
      .map((r) => r.id);
    const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  async function reconcile(direction: Direction, bucketIds: string[]) {
    setReconciling(true);
    try {
      const result = await api<{ synced: number; failed: number }>(
        '/next-api/garage/buckets/reconcile',
        {
          method: 'POST',
          body: { direction, includeObjects: true, bucketIds },
        }
      );
      const verb =
        direction === 'adopt-garage'
          ? 'adopted from Garage'
          : 'pushed to Garage';
      toast.success(
        `${result.synced} bucket${result.synced === 1 ? '' : 's'} ${verb}` +
          (result.failed > 0 ? ` · ${result.failed} failed` : '')
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reconcile failed');
      return;
    } finally {
      setReconciling(false);
    }
    // Separate try: a failing reload must not be reported as a failed write,
    // which is what the single-try version on /admin/buckets used to do.
    try {
      await refresh();
    } catch {
      toast.warning(
        'Reconciled, but the page could not reload — refresh to see the result.'
      );
    }
  }

  const totalObjects = groups.reduce((s, g) => s + g.objects, 0);
  const totalUsedBytes = groups.reduce((s, g) => s + g.usedBytes, 0);

  return (
    <div className="p-8 max-w-7xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Quota</h1>
        <p className="text-muted-foreground mt-1 max-w-3xl">
          PocketBase records what a bucket&apos;s quota should be; Garage
          enforces it. The two are written by separate calls with no rollback
          between them, so a failure in the middle leaves them disagreeing. This
          is where they are compared — on both the size and object-count axes —
          and repaired.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Buckets</CardDescription>
            <CardTitle>{audit?.total ?? '—'}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            across {groups.length} user{groups.length === 1 ? '' : 's'}
          </CardContent>
        </Card>
        <Card
          className={
            audit && audit.drifted > 0 ? 'border-destructive/50' : undefined
          }
        >
          <CardHeader className="pb-2">
            <CardDescription>Drifted</CardDescription>
            <CardTitle
              className={
                audit && audit.drifted > 0 ? 'text-destructive' : undefined
              }
            >
              {audit?.drifted ?? '—'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {audit && audit.unknown > 0
              ? `${audit.unknown} could not be checked`
              : 'every bucket checked'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total storage</CardDescription>
            <CardTitle>{formatBytes(totalUsedBytes)}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            used
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total objects</CardDescription>
            <CardTitle>{totalObjects.toLocaleString()}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            stored
          </CardContent>
        </Card>
      </div>

      {audit && audit.drifted > 0 && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-base">Quota drift detected</CardTitle>
            <CardDescription>
              {audit.drifted} bucket{audit.drifted === 1 ? '' : 's'} where what
              we record disagrees with what Garage enforces
              {audit.unknown > 0 && ` · ${audit.unknown} could not be checked`}.
              Adopting takes Garage as the truth; pushing re-applies our value,
              which is what repairs a quota change that only half landed.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground mr-auto">
              {selected.size} selected
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set(driftedIds))}
            >
              Select all drifted
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={reconciling || selected.size === 0}
              onClick={() => setPendingDirection('adopt-garage')}
            >
              Adopt Garage values
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={reconciling || selected.size === 0}
              onClick={() => setPendingDirection('push-pb')}
            >
              Push our values to Garage
            </Button>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : groups.length === 0 ? (
        <p className="text-muted-foreground">No buckets yet.</p>
      ) : (
        groups.map((group) => (
          <Card key={group.userId}>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                {group.email}
                {group.driftedCount > 0 && (
                  <Badge variant="destructive">
                    {group.driftedCount} drifted
                  </Badge>
                )}
                {group.unknownCount > 0 && (
                  <Badge variant="outline">{group.unknownCount} unknown</Badge>
                )}
              </CardTitle>
              <CardDescription>
                {group.position ? (
                  <>
                    Granted{' '}
                    <strong>
                      {formatStorage(group.position.net_granted_gb)}
                    </strong>{' '}
                    · allocated{' '}
                    <strong>{formatStorage(group.allocatedGb)}</strong> ·
                    available{' '}
                    <strong>
                      {formatStorage(group.position.available_gb)}
                    </strong>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    Storage position unavailable for this user
                  </span>
                )}{' '}
                · used <strong>{formatBytes(group.usedBytes)}</strong> ·{' '}
                <strong>{group.objects.toLocaleString()}</strong> objects ·{' '}
                {group.rows.length} bucket{group.rows.length === 1 ? '' : 's'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <Checkbox
                        aria-label={`Select drifted buckets for ${group.email}`}
                        disabled={group.driftedCount === 0}
                        checked={
                          group.driftedCount > 0 &&
                          group.rows
                            .filter((r) => r.status === 'drifted')
                            .every((r) => selected.has(r.id))
                        }
                        onCheckedChange={() => toggleGroup(group)}
                      />
                    </TableHead>
                    <TableHead>Bucket</TableHead>
                    <TableHead>Size quota</TableHead>
                    <TableHead>Object quota</TableHead>
                    <TableHead className="text-right">Used</TableHead>
                    <TableHead className="text-right">Objects</TableHead>
                    <TableHead className="w-32" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.rows.map((row) => {
                    const expected = row.expected_max_objects ?? null;
                    return (
                      <TableRow
                        key={row.id}
                        className={
                          row.status === 'drifted'
                            ? 'bg-destructive/5'
                            : undefined
                        }
                      >
                        <TableCell>
                          <Checkbox
                            aria-label={`Select ${row.name}`}
                            // Unknown means the Garage read failed. Reconciling
                            // it would just re-fail, so it cannot be selected.
                            disabled={row.status !== 'drifted'}
                            checked={selected.has(row.id)}
                            onCheckedChange={() => toggleRow(row.id)}
                          />
                        </TableCell>
                        <TableCell className="font-medium">
                          {row.name}
                          {row.status === 'unknown' && (
                            <Badge
                              variant="outline"
                              className="ml-2"
                              title={row.error ?? 'Garage did not answer'}
                            >
                              unknown
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {formatStorage(row.pb_quota_gb)}
                          {row.size_drifted && (
                            <div
                              className="text-xs text-destructive"
                              title="PocketBase and Garage disagree about the size quota"
                            >
                              Garage has{' '}
                              {formatStorage(row.garage_quota_gb ?? 0)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {expected === null ? (
                            <span className="text-muted-foreground">none</span>
                          ) : (
                            expected.toLocaleString()
                          )}
                          <span className="text-muted-foreground text-xs ml-1">
                            {row.status === 'unknown'
                              ? ''
                              : row.object_quota_overridden
                                ? '(override)'
                                : '(derived)'}
                          </span>
                          {row.objects_drifted && (
                            <div
                              className="text-xs text-destructive"
                              title="Garage's object cap does not match what this bucket should be under"
                            >
                              Garage has{' '}
                              {row.garage_max_objects
                                ? row.garage_max_objects.toLocaleString()
                                : 'no cap'}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.bytes === undefined ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <>
                              {formatBytes(row.bytes)}
                              <QuotaFillPct
                                used={row.bytes}
                                cap={gibToBytes(row.pb_quota_gb)}
                              />
                            </>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.objects === undefined ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <>
                              {row.objects.toLocaleString()}
                              <QuotaFillPct used={row.objects} cap={expected} />
                            </>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7"
                            onClick={() => setQuotaTarget(row)}
                          >
                            Change quota
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ))
      )}

      <OtpVerificationDialog
        open={pendingDirection !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDirection(null);
        }}
        actionLabel={
          pendingDirection === 'push-pb'
            ? `push ${selected.size} bucket quota${selected.size === 1 ? '' : 's'} to Garage`
            : `adopt Garage's values for ${selected.size} bucket${selected.size === 1 ? '' : 's'}`
        }
        onVerified={() => {
          // Read into a local first: the dialog calls onOpenChange(false)
          // before onVerified, and that handler nulls the state.
          const dir = pendingDirection;
          if (dir) void reconcile(dir, [...selected]);
        }}
      />

      {quotaTarget && (
        <ChangeBucketQuotaDialog
          // Keyed by bucket so switching rows remounts the dialog and its
          // fields re-seed from the new bucket's props, rather than an effect
          // writing over state the initialisers already set.
          key={quotaTarget.id}
          open
          onOpenChange={(open) => {
            if (!open) setQuotaTarget(null);
          }}
          bucketId={quotaTarget.id}
          bucketName={quotaTarget.name}
          ownerEmail={quotaTarget.user_email ?? quotaTarget.user}
          ownerId={quotaTarget.user}
          currentGb={quotaTarget.pb_quota_gb}
          garageGb={quotaTarget.garage_quota_gb ?? null}
          currentObjectQuota={quotaTarget.pb_object_quota}
          garageMaxObjects={quotaTarget.garage_max_objects ?? null}
          avgObjectSizeBytes={audit?.avg_object_size_bytes ?? null}
          onApplied={refresh}
        />
      )}
    </div>
  );
}
