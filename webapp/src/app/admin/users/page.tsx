'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Shield, ShieldOff, UserPlus } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { formatBytes, formatStorage } from '@/lib/format';
import { toast } from 'sonner';
import { InviteUserDialog } from '@/components/admin/invite-user-dialog';

interface AdminUser {
  id: string;
  email: string;
  name?: string;
  granted_gb: number;
  used_bytes: number;
  created?: string;
}

interface AdminRecord {
  id: string;
  user: string;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [admins, setAdmins] = useState<Set<string>>(new Set());
  const [inviteOpen, setInviteOpen] = useState(false);

  async function refresh() {
    const [usersResp, adminsResp] = await Promise.all([
      api<{ items: AdminUser[] }>('/next-api/garage/users'),
      api<{ items: AdminRecord[] }>('/next-api/garage/admins'),
    ]);
    setUsers(usersResp.items);
    setAdmins(new Set(adminsResp.items.map((a) => a.user)));
  }

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [usersResp, adminsResp] = await Promise.all([
          api<{ items: AdminUser[] }>('/next-api/garage/users'),
          api<{ items: AdminRecord[] }>('/next-api/garage/admins'),
        ]);
        if (cancelled) return;
        setUsers(usersResp.items);
        setAdmins(new Set(adminsResp.items.map((a) => a.user)));
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

  async function toggleAdmin(user: AdminUser) {
    const isAdmin = admins.has(user.id);
    try {
      if (isAdmin) {
        await api('/next-api/garage/admins', {
          method: 'DELETE',
          body: { user_id: user.id },
        });
        toast.success(`Demoted ${user.email}`);
      } else {
        await api('/next-api/garage/admins', {
          method: 'POST',
          body: { user_id: user.id },
        });
        toast.success(`Promoted ${user.email}`);
      }
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    }
  }

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold">Users</h1>
        <Button onClick={() => setInviteOpen(true)}>
          <UserPlus className="mr-1 h-4 w-4" /> Invite user
        </Button>
      </div>

      <InviteUserDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={refresh}
      />

      <Card>
        <CardHeader>
          <CardTitle>All users</CardTitle>
          <CardDescription>
            Total granted storage is the sum of per-node claims. Manage claims
            in the{' '}
            <Link href="/admin/claims" className="underline">
              Claims
            </Link>{' '}
            tab.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Granted</TableHead>
                <TableHead>Used</TableHead>
                <TableHead>Admin</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.email}</TableCell>
                  <TableCell>{u.name || '—'}</TableCell>
                  <TableCell>{formatStorage(u.granted_gb ?? 0)}</TableCell>
                  <TableCell>{formatBytes(u.used_bytes ?? 0)}</TableCell>
                  <TableCell>{admins.has(u.id) ? 'Yes' : '—'}</TableCell>
                  <TableCell className="text-right space-x-2">
                    <Link href={`/admin/claims?userId=${u.id}`}>
                      <Button size="sm" variant="outline">
                        Manage claims <ArrowRight className="ml-1 h-3 w-3" />
                      </Button>
                    </Link>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => toggleAdmin(u)}
                    >
                      {admins.has(u.id) ? (
                        <>
                          <ShieldOff className="mr-1 h-3 w-3" /> Demote
                        </>
                      ) : (
                        <>
                          <Shield className="mr-1 h-3 w-3" /> Promote
                        </>
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
