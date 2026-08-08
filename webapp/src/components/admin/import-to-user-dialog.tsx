'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api-client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { AdminUserRef } from '@/lib/admin-types';

interface ImportToUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: (userId: string) => Promise<void>;
}

export function ImportToUserDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Import',
  onConfirm,
}: ImportToUserDialogProps) {
  const [users, setUsers] = useState<AdminUserRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const resp = await api<{ items: AdminUserRef[] }>(
          '/next-api/garage/users'
        );
        if (cancelled) return;
        setUsers(resp.items);
      } catch (err) {
        if (!cancelled)
          toast.error(
            err instanceof Error ? err.message : 'Failed to load users'
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setSelected(null);
      setSearch('');
    }
  }, [open]);

  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? users.filter(
        (u) =>
          u.email?.toLowerCase().includes(needle) ||
          u.name?.toLowerCase().includes(needle)
      )
    : users;

  async function handleConfirm() {
    if (!selected) return;
    setSubmitting(true);
    try {
      await onConfirm(selected);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Input
            placeholder="Search by email or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="max-h-72 overflow-y-auto rounded-md border">
            {loading ? (
              <p className="p-3 text-sm text-muted-foreground">Loading…</p>
            ) : filtered.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                No users match.
              </p>
            ) : (
              <ul className="divide-y">
                {filtered.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(u.id)}
                      className={cn(
                        'w-full px-3 py-2 text-left text-sm hover:bg-accent',
                        selected === u.id && 'bg-accent font-medium'
                      )}
                    >
                      <div>{u.email}</div>
                      {u.name && (
                        <div className="text-xs text-muted-foreground">
                          {u.name}
                        </div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!selected || submitting}>
            {submitting ? 'Importing…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
