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
  /**
   * The owner's PocketBase id. Their grant is fetched here rather than passed
   * in: the admin buckets page reads users from `/next-api/garage/users`, which
   * returns a single 200-row page, so any owner past that page arrived as a
   * grant of 0 and the dialog refused every quota as over-grant.
   */
  ownerId: string;
  onApplied: () => void | Promise<void>;
}

interface OwnerPosition {
  grantedGb: number;
  /** Everything the owner's buckets reserve, this one included. */
  allocatedGb: number;
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
  ownerId,
  onApplied,
}: Props) {
  const [targetGb, setTargetGb] = useState(currentGb);
  const [submitting, setSubmitting] = useState(false);
  const [position, setPosition] = useState<OwnerPosition | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        const summary = await api<{
          netGrantedGb: number;
          allocatedGb: number;
        }>(
          `/next-api/garage/storage-summary?userId=${encodeURIComponent(ownerId)}`
        );
        if (cancelled) return;
        setPosition({
          grantedGb: summary.netGrantedGb,
          allocatedGb: summary.allocatedGb,
        });
      } catch (err) {
        if (cancelled) return;
        setPositionError(
          err instanceof Error ? err.message : 'Could not read the owner grant'
        );
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [open, ownerId]);

  // This bucket's own quota is being replaced, so counting it would charge the
  // owner twice against their own grant.
  const ownerOtherAllocatedGb = position
    ? Math.max(position.allocatedGb - currentGb, 0)
    : 0;
  const remainingGb = position
    ? position.grantedGb - ownerOtherAllocatedGb - targetGb
    : 0;
  // Only a *known* grant can block the form. While the position is loading, or
  // if it could not be read at all, fall through to the server's own check —
  // refusing to submit on an unknown grant is how this dialog used to dead-end.
  const overGrant = position !== null && remainingGb < 0;
  const invalid = !Number.isFinite(targetGb) || targetGb < 0;
  const unchanged = targetGb === currentGb;
  const driftedFromGarage = garageGb !== null && garageGb !== currentGb;
  const loadingPosition = position === null && positionError === null;

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
            {loadingPosition && <>Checking the owner&apos;s grant…</>}
            {positionError && (
              <>Owner grant unavailable — the server will validate on save.</>
            )}
            {position && (
              <>
                Owner grant:{' '}
                <strong>{formatStorage(position.grantedGb)}</strong> · their
                other buckets:{' '}
                <strong>{formatStorage(ownerOtherAllocatedGb)}</strong> · left
                after this:{' '}
                <strong className={overGrant ? 'text-destructive' : undefined}>
                  {formatStorage(Math.max(remainingGb, 0))}
                </strong>
              </>
            )}
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
