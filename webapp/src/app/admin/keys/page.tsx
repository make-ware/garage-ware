'use client';

import { useEffect, useState } from 'react';
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
import { Button } from '@/components/ui/button';
import { ImportToUserDialog } from '@/components/admin/import-to-user-dialog';
import { api } from '@/lib/api-client';
import { toast } from 'sonner';
import type { AccessKey } from '@garage-ware/shared';
import type { UnallocatedKey } from '@/app/next-api/garage/keys/unallocated/route';

type AdminAccessKey = AccessKey & {
  expand?: { user?: { email?: string; name?: string } };
};

export default function AdminKeysPage() {
  const [keys, setKeys] = useState<AdminAccessKey[]>([]);
  const [unallocated, setUnallocated] = useState<UnallocatedKey[]>([]);
  const [importing, setImporting] = useState<UnallocatedKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [all, free] = await Promise.all([
          api<{ items: AdminAccessKey[] }>('/next-api/garage/keys?all=true'),
          api<{ items: UnallocatedKey[] }>('/next-api/garage/keys/unallocated'),
        ]);
        if (cancelled) return;
        setKeys(all.items);
        setUnallocated(free.items);
      } catch (err) {
        if (!cancelled)
          toast.error(err instanceof Error ? err.message : 'Failed to load');
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    const [all, free] = await Promise.all([
      api<{ items: AdminAccessKey[] }>('/next-api/garage/keys?all=true'),
      api<{ items: UnallocatedKey[] }>('/next-api/garage/keys/unallocated'),
    ]);
    setKeys(all.items);
    setUnallocated(free.items);
  }

  async function importKey(garageKeyId: string, userId: string) {
    await api('/next-api/garage/keys/import', {
      method: 'POST',
      body: { garage_key_id: garageKeyId, user_id: userId },
    });
    toast.success('Access key imported');
    await refresh();
  }

  return (
    <div className="p-8 max-w-6xl space-y-6">
      <h1 className="text-3xl font-bold">Access keys</h1>

      <Card>
        <CardHeader>
          <CardTitle>All access keys</CardTitle>
          <CardDescription>
            {keys.length} total · S3 credentials mapped to a PocketBase user.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Garage key ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-medium">
                    {k.name || (
                      <span className="text-muted-foreground">(unnamed)</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {k.expand?.user?.email ?? k.user.slice(0, 8) + '…'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {k.garage_key_id}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Unallocated keys</CardTitle>
          <CardDescription>
            {unallocated.length === 0
              ? 'No orphaned keys in the cluster.'
              : `${unallocated.length} key${unallocated.length === 1 ? '' : 's'} in Garage with no PocketBase owner. Import to assign one to a user.`}
          </CardDescription>
        </CardHeader>
        {unallocated.length > 0 && (
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Garage key ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Bucket perms</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unallocated.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>
                      {k.name || (
                        <span className="text-muted-foreground">(unnamed)</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{k.id}</TableCell>
                    <TableCell>
                      {k.expired ? (
                        <span className="text-destructive">expired</span>
                      ) : (
                        <span className="text-muted-foreground">active</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {k.bucketCount ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setImporting(k)}
                      >
                        Import…
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        )}
      </Card>

      <ImportToUserDialog
        open={importing !== null}
        onOpenChange={(open) => {
          if (!open) setImporting(null);
        }}
        title={importing ? `Import key: ${importing.name ?? importing.id}` : ''}
        description="Choose a user to take ownership of this access key."
        confirmLabel="Import key"
        onConfirm={async (userId) => {
          if (!importing) return;
          await importKey(importing.id, userId);
        }}
      />
    </div>
  );
}
