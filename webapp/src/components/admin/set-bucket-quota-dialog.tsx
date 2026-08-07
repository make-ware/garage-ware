'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OtpGatedDialog } from '@/components/auth/otp-gated-dialog';
import { Label } from '@/components/ui/label';
import { StorageQuotaInput } from '@/components/storage/storage-quota-input';
import { api } from '@/lib/api-client';
import { formatStorage } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bucketId: string;
  bucketName: string;
  ownerEmail: string;
  /** What PocketBase currently records, in GiB. */
  currentGb: number;
  /** What Garage currently enforces, in GiB. Differs from `currentGb` on drift. */
  garageGb: number | null;
  /** Owner's net grant and what their other buckets already reserve, in GiB. */
  ownerGrantedGb: number;
  ownerOtherAllocatedGb: number;
  onApplied: () => void | Promise<void>;
}

/**
 * Override a bucket's quota as an admin, writing both Garage and PocketBase via
 * the existing PATCH handler.
 *
 * Gated behind the same OTP step-up the other destructive admin actions use.
 * Worth being clear about what that buys: the gate is client-side only — no
 * route handler reads an OTP — so it guards against a careless click, not
 * against someone with a stolen session token. Real enforcement would mean
 * verifying the code server-side.
 */
export function SetBucketQuotaDialog({
  open,
  onOpenChange,
  bucketId,
  bucketName,
  ownerEmail,
  currentGb,
  garageGb,
  ownerGrantedGb,
  ownerOtherAllocatedGb,
  onApplied,
}: Props) {
  const [targetGb, setTargetGb] = useState(currentGb);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTargetGb(currentGb);
  }, [open, currentGb, bucketId]);

  const remainingGb = ownerGrantedGb - ownerOtherAllocatedGb - targetGb;
  const overGrant = remainingGb < 0;
  const invalid = !Number.isFinite(targetGb) || targetGb < 0;
  const unchanged = targetGb === currentGb;
  const driftedFromGarage = garageGb !== null && garageGb !== currentGb;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (invalid || overGrant) return;
    setSubmitting(true);
    try {
      await api(`/next-api/garage/buckets/${bucketId}`, {
        method: 'PATCH',
        body: { quota_gb: targetGb },
      });
      toast.success(`${bucketName} quota set to ${formatStorage(targetGb)}`);
      onOpenChange(false);
      await onApplied();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Quota update failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <OtpGatedDialog
      open={open}
      onOpenChange={onOpenChange}
      actionLabel={`change the quota on ${bucketName}`}
    >
      <form onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>Set bucket quota</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground">
            <span className="font-mono text-xs">{bucketName}</span>, owned by{' '}
            <strong>{ownerEmail}</strong>. Writes the new quota to Garage and
            PocketBase, and is validated against the owner&apos;s grant — not
            yours.
          </p>

          <div className="space-y-2">
            <Label htmlFor="bucket-quota-target">Quota</Label>
            <StorageQuotaInput
              id="bucket-quota-target"
              valueGib={targetGb}
              onChangeGib={setTargetGb}
              minGib={0}
              aria-describedby="bucket-quota-summary"
            />
          </div>

          <p
            id="bucket-quota-summary"
            className="text-xs text-muted-foreground"
          >
            Recorded now: <strong>{formatStorage(currentGb)}</strong>
            {driftedFromGarage && (
              <>
                {' '}
                · Garage currently enforces{' '}
                <strong className="text-destructive">
                  {formatStorage(garageGb)}
                </strong>{' '}
                — saving resolves the disagreement
              </>
            )}
            <br />
            Owner grant: <strong>{formatStorage(ownerGrantedGb)}</strong> ·
            their other buckets:{' '}
            <strong>{formatStorage(ownerOtherAllocatedGb)}</strong> · left after
            this:{' '}
            <strong className={overGrant ? 'text-destructive' : undefined}>
              {formatStorage(Math.max(remainingGb, 0))}
            </strong>
          </p>

          {overGrant && (
            <p className="text-xs text-destructive">
              That exceeds what the owner has been granted. Raise their claim
              first, or the server will reject it.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={submitting || invalid || overGrant || unchanged}
          >
            {submitting ? 'Saving...' : 'Save quota'}
          </Button>
        </DialogFooter>
      </form>
    </OtpGatedDialog>
  );
}
