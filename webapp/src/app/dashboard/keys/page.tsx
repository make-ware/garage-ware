'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Copy } from 'lucide-react';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { OtpGatedDialog } from '@/components/auth/otp-gated-dialog';
import { api } from '@/lib/api-client';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AccessKey } from '@garage-ware/shared';

interface CreatedSecret {
  garage_key_id: string;
  secret_access_key: string;
  name: string;
}

function KeysView() {
  const router = useRouter();
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [secret, setSecret] = useState<CreatedSecret | null>(null);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function refresh() {
    const result = await api<{ items: AccessKey[] }>('/next-api/garage/keys');
    setKeys(result.items);
  }

  useEffect(() => {
    refresh()
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const created = await api<{
        garage_key_id: string;
        secret_access_key: string;
      }>('/next-api/garage/keys', {
        method: 'POST',
        body: { name },
      });
      setSecret({
        garage_key_id: created.garage_key_id,
        secret_access_key: created.secret_access_key,
        name,
      });
      setName('');
      setCreateOpen(false);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="mb-6">
        <Link
          href="/dashboard"
          className="text-sm text-muted-foreground hover:underline inline-flex items-center"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to dashboard
        </Link>
        <div className="mt-2 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Access keys</h1>
            <p className="text-muted-foreground">
              S3 credentials for your buckets. Secrets are shown once at
              creation.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New key
          </Button>
          <OtpGatedDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            actionLabel="create this key"
          >
            <form onSubmit={createKey}>
              <DialogHeader>
                <DialogTitle>Create access key</DialogTitle>
                <DialogDescription>
                  Pick a label so you remember what this key is for. The secret
                  will be shown only once after creation.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="key-name">Label</Label>
                  <Input
                    id="key-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="laptop-2026"
                    required
                  />
                </div>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={submitting}>
                  {submitting ? 'Creating...' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </OtpGatedDialog>
        </div>
      </div>

      {secret && (
        <Alert className="mb-6">
          <AlertTitle>Save this secret now</AlertTitle>
          <AlertDescription>
            This is the only time you can see it. After this dialog closes the
            secret is gone forever.
            <div className="mt-3 space-y-2 font-mono text-xs">
              <div>
                <span className="text-muted-foreground">access key:</span>{' '}
                {secret.garage_key_id}
                <CopyButton text={secret.garage_key_id} />
              </div>
              <div>
                <span className="text-muted-foreground">secret key:</span>{' '}
                {secret.secret_access_key}
                <CopyButton text={secret.secret_access_key} />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setSecret(null)}
            >
              I&apos;ve saved it
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Your keys</CardTitle>
          <CardDescription>{keys.length} active</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : keys.length === 0 ? (
            <p className="text-muted-foreground">No keys yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Access key ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow
                    key={k.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/dashboard/keys/${k.id}`)}
                  >
                    <TableCell className="font-medium">
                      {k.name || '(unnamed)'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {k.garage_key_id}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="ml-2 h-6 px-2"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        toast.success('Copied');
      }}
    >
      <Copy className="h-3 w-3" />
    </Button>
  );
}

export default function KeysPage() {
  return (
    <ProtectedRoute>
      <KeysView />
    </ProtectedRoute>
  );
}
