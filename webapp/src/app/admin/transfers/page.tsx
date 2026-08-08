'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
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
import { formatPbDate, formatStorage } from '@/lib/format';
import { StorageQuotaInput } from '@/components/storage/storage-quota-input';
import type { AdminUser } from '@/lib/admin-types';
import type { StorageTransfer } from '@garage-ware/shared';

function AdminTransfersView() {
  const params = useSearchParams();
  const filterUserId = params.get('userId');

  const [transfers, setTransfers] = useState<StorageTransfer[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [formFromUser, setFormFromUser] = useState('');
  const [formToEmail, setFormToEmail] = useState('');
  const [formQuotaGib, setFormQuotaGib] = useState<number>(0);
  const [formNote, setFormNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function refresh() {
    const [transfersResp, usersResp] = await Promise.all([
      api<{ items: StorageTransfer[] }>('/next-api/garage/transfers?all=true'),
      api<{ items: AdminUser[] }>('/next-api/garage/users'),
    ]);
    setTransfers(transfersResp.items);
    setUsers(usersResp.items);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [transfersResp, usersResp] = await Promise.all([
          api<{ items: StorageTransfer[] }>(
            '/next-api/garage/transfers?all=true'
          ),
          api<{ items: AdminUser[] }>('/next-api/garage/users'),
        ]);
        if (cancelled) return;
        setTransfers(transfersResp.items);
        setUsers(usersResp.items);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  const visibleTransfers = useMemo(
    () =>
      filterUserId
        ? transfers.filter(
            (t) => t.from_user === filterUserId || t.to_user === filterUserId
          )
        : transfers,
    [transfers, filterUserId]
  );

  async function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!formFromUser || !formToEmail.trim()) {
      toast.error('Select a sender and enter a recipient email');
      return;
    }
    if (!Number.isFinite(formQuotaGib) || formQuotaGib <= 0) {
      toast.error('Amount must be a positive number');
      return;
    }
    setSubmitting(true);
    try {
      await api('/next-api/garage/transfers', {
        method: 'POST',
        body: {
          from_user_id: formFromUser,
          to_user_email: formToEmail.trim(),
          quota_gb: formQuotaGib,
          note: formNote.trim() || undefined,
        },
      });
      toast.success('Transfer created');
      setFormToEmail('');
      setFormQuotaGib(0);
      setFormNote('');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(transfer: StorageTransfer) {
    await api(`/next-api/garage/transfers/${transfer.id}`, {
      method: 'DELETE',
    });
    toast.success('Transfer removed');
    await refresh();
  }

  const filterUser = filterUserId ? userById.get(filterUserId) : null;

  return (
    <div className="p-8 max-w-6xl">
      <h1 className="text-3xl font-bold mb-2">Storage transfers</h1>
      <p className="text-muted-foreground mb-6">
        Transfer storage capacity between users. The sender must have enough
        unallocated capacity; the recipient can return the transfer at any time
        as long as their bucket quotas still fit.
      </p>

      {filterUserId && (
        <p className="text-sm mb-4">
          Filtering by user <strong>{filterUser?.email ?? filterUserId}</strong>{' '}
          —{' '}
          <Link href="/admin/transfers" className="underline">
            show all
          </Link>
        </p>
      )}

      {error && <p className="text-destructive mb-4">{error}</p>}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>New transfer</CardTitle>
          <CardDescription>
            Move unallocated storage from one user to another. The amount is
            deducted from the sender&apos;s available capacity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={submit}
            className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end"
          >
            <div className="space-y-2">
              <Label>From user</Label>
              <Select value={formFromUser} onValueChange={setFormFromUser}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick sender" />
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
              <Label htmlFor="transfer-to-email">To (email)</Label>
              <Input
                id="transfer-to-email"
                type="email"
                placeholder="recipient@example.com"
                value={formToEmail}
                onChange={(e) => setFormToEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="transfer-quota">Amount</Label>
              <StorageQuotaInput
                id="transfer-quota"
                valueGib={formQuotaGib}
                onChangeGib={setFormQuotaGib}
                min={0.001}
              />
            </div>
            <Button type="submit" disabled={submitting}>
              <Plus className="mr-1 h-4 w-4" />
              {submitting ? 'Creating...' : 'Create transfer'}
            </Button>
            <div className="md:col-span-4 space-y-2">
              <Label htmlFor="transfer-note">Note (optional)</Label>
              <Input
                id="transfer-note"
                placeholder="Reason for transfer…"
                value={formNote}
                onChange={(e) => setFormNote(e.target.value)}
                maxLength={500}
              />
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All transfers</CardTitle>
          <CardDescription>
            {visibleTransfers.length} transfer
            {visibleTransfers.length === 1 ? '' : 's'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : visibleTransfers.length === 0 ? (
            <p className="text-muted-foreground">No transfers yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleTransfers.map((t) => {
                  const fromUser = userById.get(t.from_user);
                  const toUser = userById.get(t.to_user);
                  return (
                    <TableRow key={t.id}>
                      <TableCell>{fromUser?.email ?? t.from_user}</TableCell>
                      <TableCell>{toUser?.email ?? t.to_user}</TableCell>
                      <TableCell>{formatStorage(t.quota_gb)}</TableCell>
                      <TableCell className="text-muted-foreground max-w-[200px] truncate">
                        {t.note || '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatPbDate(t.created)}
                      </TableCell>
                      <TableCell className="text-right">
                        <ConfirmDeleteDialog
                          trigger={
                            <Button size="sm" variant="ghost">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          }
                          title="Remove transfer"
                          description={
                            <p>
                              Returns {formatStorage(t.quota_gb)} from{' '}
                              {toUser?.email ?? 'recipient'} back to{' '}
                              {fromUser?.email ?? 'sender'}. This will fail if
                              the recipient&apos;s bucket quotas exceed their
                              remaining capacity.
                            </p>
                          }
                          confirmText={toUser?.email ?? t.to_user}
                          confirmLabel="Remove transfer"
                          onConfirm={() => remove(t)}
                        />
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

export default function AdminTransfersPage() {
  return (
    <Suspense fallback={<div className="p-8">Loading...</div>}>
      <AdminTransfersView />
    </Suspense>
  );
}
