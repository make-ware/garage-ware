'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StorageQuotaInput } from '@/components/storage/storage-quota-input';
import { useOwnerPosition } from '@/hooks/use-owner-position';
import { api } from '@/lib/api-client';
import { formatStorage } from '@/lib/format';
import { deriveMaxObjects } from '@/lib/storage/object-cap';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bucketId: string;
  bucketName: string;
  ownerEmail: string;
  ownerId: string;
  /** PocketBase's size quota, binary GiB. */
  currentGb: number;
  /** Garage's enforced size quota in GiB; null when the audit said 'unknown'. */
  garageGb: number | null;
  /** PocketBase's persisted override. 0 = derive from the average. */
  currentObjectQuota: number;
  /** Garage's enforced object cap. 0 = uncapped; null when unknown. */
  garageMaxObjects: number | null;
  /** GARAGE_AVG_OBJECT_SIZE_MB in bytes, from the quota-audit envelope. */
  avgObjectSizeBytes: number | null;
  onApplied: () => void | Promise<void>;
}

/**
 * Change a bucket's size and object quotas as an admin.
 *
 * Gated by a type-the-bucket-name challenge rather than the OTP step-up the
 * other admin actions use. The distinction is deliberate: an OTP proves it is
 * still you, a name challenge proves you meant *this bucket*. Editing a quota
 * on the wrong row is the failure mode worth defending against here, and it is
 * the one an OTP does nothing about.
 *
 * Neither gate is server-enforced — no route handler reads an OTP or a typed
 * name — so this guards against a careless click, not a stolen session.
 */
export function ChangeBucketQuotaDialog({
  open,
  onOpenChange,
  bucketId,
  bucketName,
  ownerEmail,
  ownerId,
  currentGb,
  garageGb,
  currentObjectQuota,
  garageMaxObjects,
  avgObjectSizeBytes,
  onApplied,
}: Props) {
  const [targetGb, setTargetGb] = useState(currentGb);
  const [objectsText, setObjectsText] = useState(
    currentObjectQuota > 0 ? String(currentObjectQuota) : ''
  );
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const {
    position,
    error: positionError,
    loading,
  } = useOwnerPosition(ownerId, open);

  const targetObjects = objectsText.trim() === '' ? 0 : Number(objectsText);

  // This bucket's own quota is being replaced, so counting it would charge the
  // owner twice against their own grant.
  const ownerOtherAllocatedGb = position
    ? Math.max(position.allocatedGb - currentGb, 0)
    : 0;
  const remainingGb = position
    ? position.grantedGb - ownerOtherAllocatedGb - targetGb
    : 0;
  // Only a *known* grant can block the form. While the position is loading, or
  // if it could not be read at all, fall through to the server's own check.
  const overGrant = position !== null && remainingGb < 0;

  const sizeInvalid = !Number.isFinite(targetGb) || targetGb < 0;
  const objectsInvalid =
    !Number.isFinite(targetObjects) ||
    !Number.isInteger(targetObjects) ||
    targetObjects < 0;

  const sizeChanged = targetGb !== currentGb;
  const objectsChanged = targetObjects !== currentObjectQuota;
  const unchanged = !sizeChanged && !objectsChanged;
  const matches = typed === bucketName;

  const derived = deriveMaxObjects(targetGb, avgObjectSizeBytes);
  const effective = targetObjects > 0 ? targetObjects : derived;
  const driftedFromGarage = garageGb !== null && garageGb !== currentGb;
  const objectsDriftedFromGarage =
    garageMaxObjects !== null && garageMaxObjects !== (effective ?? 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (sizeInvalid || objectsInvalid || overGrant || unchanged || !matches) {
      return;
    }
    setSubmitting(true);
    try {
      // Only the changed axis is sent: that is what lets the handler skip the
      // layout fetch and grant check on an object-only edit.
      await api(`/next-api/garage/buckets/${bucketId}`, {
        method: 'PATCH',
        body: {
          ...(sizeChanged && { quota_gb: targetGb }),
          ...(objectsChanged && { object_quota: targetObjects }),
        },
      });
      toast.success(`${bucketName} quota updated`);
      onOpenChange(false);
      await onApplied();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Quota update failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Change bucket quota</DialogTitle>
            <DialogDescription>
              <span className="font-mono text-xs">{bucketName}</span>, owned by{' '}
              <strong>{ownerEmail}</strong>. Writes to Garage and PocketBase,
              and is validated against the owner&apos;s grant — not yours.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="change-quota-size">Size quota</Label>
              <StorageQuotaInput
                id="change-quota-size"
                valueGib={targetGb}
                onChangeGib={setTargetGb}
                minGib={0}
                aria-describedby="change-quota-size-summary"
              />
              <p
                id="change-quota-size-summary"
                className="text-xs text-muted-foreground"
              >
                Recorded now: <strong>{formatStorage(currentGb)}</strong>
                {driftedFromGarage && (
                  <>
                    {' '}
                    · Garage enforces{' '}
                    <strong className="text-destructive">
                      {formatStorage(garageGb)}
                    </strong>{' '}
                    — saving resolves the disagreement
                  </>
                )}
                <br />
                {loading && <>Checking the owner&apos;s grant…</>}
                {positionError && (
                  <>
                    Owner grant unavailable — the server will validate on save.
                  </>
                )}
                {position && (
                  <>
                    Owner grant:{' '}
                    <strong>{formatStorage(position.grantedGb)}</strong> · their
                    other buckets:{' '}
                    <strong>{formatStorage(ownerOtherAllocatedGb)}</strong> ·
                    left after this:{' '}
                    <strong
                      className={overGrant ? 'text-destructive' : undefined}
                    >
                      {formatStorage(Math.max(remainingGb, 0))}
                    </strong>
                  </>
                )}
              </p>
              {overGrant && (
                <p className="text-xs text-destructive">
                  That exceeds what the owner has been granted. Raise their
                  claim first, or the server will reject it.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="change-quota-objects">Object quota</Label>
              <Input
                id="change-quota-objects"
                type="number"
                min={0}
                step={1}
                value={objectsText}
                onChange={(e) => setObjectsText(e.target.value)}
                placeholder="0 — derive from the average object size"
                aria-describedby="change-quota-objects-summary"
                aria-invalid={objectsInvalid || undefined}
              />
              <p
                id="change-quota-objects-summary"
                className="text-xs text-muted-foreground"
              >
                {targetObjects > 0 ? (
                  <>
                    Override: <strong>{targetObjects.toLocaleString()}</strong>{' '}
                    objects
                    {derived !== null && (
                      <>
                        {' '}
                        (this size quota would otherwise derive{' '}
                        <strong>{derived.toLocaleString()}</strong>)
                      </>
                    )}
                  </>
                ) : derived !== null ? (
                  <>
                    No override — this size quota derives a cap of{' '}
                    <strong>{derived.toLocaleString()}</strong> objects.
                  </>
                ) : (
                  <>
                    No override, and no average object size is configured —
                    Garage will cap nothing.
                  </>
                )}
                {objectsDriftedFromGarage && (
                  <>
                    {' '}
                    · Garage enforces{' '}
                    <strong className="text-destructive">
                      {garageMaxObjects === 0
                        ? 'no cap'
                        : garageMaxObjects?.toLocaleString()}
                    </strong>{' '}
                    — saving resolves the disagreement
                  </>
                )}
                <br />
                Object caps are not drawn from the owner&apos;s storage claim.
              </p>
              {objectsInvalid && (
                <p className="text-xs text-destructive">
                  Enter a whole number of objects, or 0 to derive it.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="change-quota-confirm">
                Type{' '}
                <span className="font-mono font-semibold">{bucketName}</span> to
                confirm
              </Label>
              <Input
                id="change-quota-confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
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
              disabled={
                submitting ||
                sizeInvalid ||
                objectsInvalid ||
                overGrant ||
                unchanged ||
                !matches
              }
            >
              {submitting ? 'Saving...' : 'Save quota'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
