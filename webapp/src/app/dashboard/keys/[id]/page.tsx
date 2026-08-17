'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
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
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import type { AccessKey } from '@garage-ware/shared';
import type { GarageKey } from '@/lib/garage';

interface DetailResponse {
  record: AccessKey;
  garage: GarageKey;
}

function KeyDetail({ id }: { id: string }) {
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

  /**
   * Retire the key, or bring it back.
   *
   * Stays on the page rather than routing away: the key still exists and its
   * state has changed, so the useful thing to show is the key with its new
   * state and the button that undoes it.
   */
  async function setExpired(expired: boolean) {
    await api(`/next-api/garage/keys/${id}/expiry`, {
      method: 'POST',
      body: { expired },
    });
    const label = data?.record.name || data?.record.garage_key_id;
    toast.success(expired ? `Expired ${label}` : `Re-enabled ${label}`);
    const fresh = await api<DetailResponse>(`/next-api/garage/keys/${id}`);
    setData(fresh);
  }

  /**
   * The un-expire click, with the error handling the confirm dialog does for
   * the other direction.
   *
   * Reversibility is the safety property this whole design leans on — a retire
   * button with no way back would be the griefing lever the app refuses
   * everywhere else — so a failed re-enable must say so. Bare
   * `void setExpired(false)` swallowed it into an unhandled rejection: no toast,
   * the card still reading "Key is expired", and a user clicking again.
   */
  async function reEnable() {
    try {
      await setExpired(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not re-enable the key'
      );
    }
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
  const expired = data.garage.expired === true;

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

      <Card>
        <CardHeader>
          <CardTitle>
            {expired ? 'Key is expired' : 'Retire this key'}
          </CardTitle>
          <CardDescription>
            {expired
              ? 'This key no longer works for S3. Its bucket permissions are kept, so re-enabling it restores exactly the access it had.'
              : 'Expiring a key stops it working for S3 straight away, while keeping it and its bucket permissions on record. This is the way to rotate onto a new key: create the replacement, point your tools at it, then expire this one.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {expired ? (
            <Button variant="outline" onClick={() => void reEnable()}>
              Re-enable key
            </Button>
          ) : (
            <ConfirmDeleteDialog
              trigger={<Button variant="outline">Expire key</Button>}
              variant="default"
              title={`Expire key ${confirmText}`}
              description={
                <>
                  <p>
                    Applications still configured with{' '}
                    <strong>{confirmText}</strong> will start failing
                    immediately.
                  </p>
                  <p>
                    You can re-enable it here afterwards — nothing is destroyed.
                    To remove a key from the cluster for good, use{' '}
                    <code className="font-mono">garage key delete</code> on the
                    cluster itself.
                  </p>
                </>
              }
              confirmText={confirmText}
              confirmLabel="Expire key"
              pendingLabel="Expiring..."
              onConfirm={() => setExpired(true)}
            />
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
