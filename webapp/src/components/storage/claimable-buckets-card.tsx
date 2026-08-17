'use client';

import { useState } from 'react';
import { toast } from 'sonner';
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
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { api } from '@/lib/api-client';
import { formatBytes, formatStorage } from '@/lib/format';
import { bytesToGib } from '@/lib/storage/units';
import type { ClaimableBucket } from '@/lib/types';

/**
 * Buckets on the cluster that this user could claim, and the button to do it.
 *
 * Renders nothing when the list is empty, which is the common case — a user
 * whose buckets were all made here has nothing to onboard, and an empty
 * "Claimable buckets" card would be a permanent invitation to wonder what it
 * means.
 *
 * The list is derived, not typed: every row is a bucket one of the user's own
 * claimed access keys holds Garage `owner` permission on. Claiming a key is
 * what makes buckets appear here, which is the whole trust chain visible in one
 * screen.
 *
 * The gate is the type-the-name challenge rather than the OTP step-up, for the
 * reason `change-bucket-quota-dialog.tsx` already gives: an OTP asks *is it
 * still you*, which the session has answered, while a name challenge asks *did
 * you mean this bucket*. Claiming the wrong row is the mistake worth guarding.
 * As everywhere else in this app, neither gate is server-enforced — the proof
 * that secures this lives in the route.
 */

interface ClaimableBucketsCardProps {
  items: ClaimableBucket[];
  onClaimed: () => Promise<void> | void;
  /** What the user has left to reserve, so the card can say what will happen. */
  freeGb: number;
}

export function ClaimableBucketsCard({
  items,
  onClaimed,
  freeGb,
}: ClaimableBucketsCardProps) {
  const [claiming, setClaiming] = useState<string | null>(null);

  if (items.length === 0) return null;

  async function claim(bucket: ClaimableBucket) {
    setClaiming(bucket.id);
    try {
      const result = await api<{ quotaGb: number; quotaDeferred: boolean }>(
        '/next-api/garage/buckets/claim',
        { method: 'POST', body: { garage_bucket_id: bucket.id } }
      );
      // Two different successes, and conflating them would leave someone
      // wondering why their bucket shows a zero quota.
      if (result.quotaDeferred) {
        toast.warning(
          `Claimed ${bucket.name}, but you have no capacity to reserve for it yet — it is recorded with no quota. Ask an admin for storage, then set one.`
        );
      } else if (result.quotaGb > 0) {
        toast.success(
          `Claimed ${bucket.name} with its existing ${formatStorage(result.quotaGb)} quota`
        );
      } else {
        toast.success(`Claimed ${bucket.name}`);
      }
      await onClaimed();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Claim failed');
    } finally {
      setClaiming(null);
    }
  }

  return (
    <Card className="mb-6 border-dashed">
      <CardHeader>
        <CardTitle>Buckets you can claim</CardTitle>
        <CardDescription>
          These exist on the cluster and one of your access keys owns them, but
          they are not registered here yet. Claiming a bucket takes over its
          quota and usage tracking; it does not change anything stored in it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bucket</TableHead>
              <TableHead className="text-right">Stored</TableHead>
              <TableHead className="text-right">Quota in Garage</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((b) => {
              const quotaGb = b.maxSize ? bytesToGib(b.maxSize) : 0;
              const fits = quotaGb === 0 || quotaGb <= freeGb;
              return (
                <TableRow key={b.id}>
                  <TableCell className="font-medium">{b.name}</TableCell>
                  <TableCell className="text-right">
                    {b.bytes === null ? '—' : formatBytes(b.bytes)}
                  </TableCell>
                  <TableCell className="text-right">
                    {quotaGb > 0 ? (
                      <>
                        {formatStorage(quotaGb)}
                        {!fits && (
                          <span className="block text-xs text-muted-foreground">
                            more than you can reserve
                          </span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <ConfirmDeleteDialog
                      trigger={
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={claiming !== null}
                        >
                          Claim
                        </Button>
                      }
                      variant="default"
                      title="Claim this bucket"
                      description={
                        <>
                          <strong>{b.name}</strong> will be registered to your
                          account and start counting against your storage.
                          {quotaGb > 0 &&
                            (fits
                              ? ` Its existing ${formatStorage(quotaGb)} quota will be adopted.`
                              : ` Its ${formatStorage(quotaGb)} quota is more than you can reserve, so it will be claimed with no quota until you have capacity.`)}
                        </>
                      }
                      confirmText={b.name}
                      confirmLabel="Claim"
                      pendingLabel="Claiming..."
                      onConfirm={() => claim(b)}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
