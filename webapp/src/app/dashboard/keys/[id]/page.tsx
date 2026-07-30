'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Copy } from 'lucide-react';
import { ProtectedRoute } from '@/components/auth/protected-route';
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
import { OtpConfirmDeleteDialog } from '@/components/ui/otp-confirm-delete-dialog';
import type { AccessKey } from '@garage-ware/shared';
import type { GarageKey } from '@/lib/garage';

interface DetailResponse {
  record: AccessKey;
  garage: GarageKey;
}

function KeyDetail({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const detail = await api<DetailResponse>(`/next-api/garage/keys/${id}`);
        if (!cancelled) setData(detail);
      } catch (err) {
        if (!cancelled)
          toast.error(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function handleDelete() {
    await api(`/next-api/garage/keys/${id}`, { method: 'DELETE' });
    toast.success(`Revoked ${data?.record.name || data?.record.garage_key_id}`);
    router.push('/dashboard/keys');
  }

  if (loading || !data) {
    return (
      <div className="container mx-auto px-4 py-8">
        <p>Loading...</p>
      </div>
    );
  }

  const { record } = data;
  const confirmText = record.name || record.garage_key_id;

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="mb-6">
        <Link
          href="/dashboard/keys"
          className="text-sm text-muted-foreground hover:underline inline-flex items-center"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to keys
        </Link>
        <h1 className="text-3xl font-bold mt-2">
          {record.name || '(unnamed)'}
        </h1>
        <p className="text-sm text-muted-foreground font-mono">
          {record.garage_key_id}
        </p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>
            Secrets are only shown once at creation and can&apos;t be retrieved
            later.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <div className="text-xs text-muted-foreground">Access key ID</div>
            <div className="font-mono text-sm flex items-center gap-2">
              {record.garage_key_id}
              <CopyButton text={record.garage_key_id} />
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Created</div>
            <div className="text-sm">
              {new Date(record.created).toLocaleString()}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>
            Revoking this key immediately disables it on the cluster. Any
            application using it will lose access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OtpConfirmDeleteDialog
            trigger={<Button variant="destructive">Revoke key</Button>}
            title={`Revoke key ${confirmText}`}
            description={
              <>
                <p>
                  This will permanently delete the key from the Garage cluster
                  and from PocketBase. This cannot be undone.
                </p>
                <p>
                  Applications still configured with this key will start failing
                  immediately.
                </p>
              </>
            }
            confirmText={confirmText}
            confirmLabel="Revoke key"
            otpActionLabel="revoke this key"
            onConfirm={handleDelete}
          />
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
      className="h-6 px-2"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        toast.success('Copied');
      }}
    >
      <Copy className="h-3 w-3" />
    </Button>
  );
}

export default function KeyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <ProtectedRoute>
      <KeyDetail id={id} />
    </ProtectedRoute>
  );
}
