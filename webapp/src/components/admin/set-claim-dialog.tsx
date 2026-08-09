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
import { api } from '@/lib/api-client';
import { formatSignedStorage, formatStorage } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userEmail: string;
  nodeId: string;
  nodeLabel: string;
  /** The user's current effective claim on this node, in GiB. */
  currentGb: number;
  /** Unclaimed usable capacity left on the node, in GiB. */
  nodeFreeGb: number;
  /** Called after a successful adjustment so the parent can refresh. */
  onApplied: () => void | Promise<void>;
}

/**
 * Set a user's claim on one node to a new total.
 *
 * The ledger stores signed adjustments, not states, so "grow this user to 8 TB"
 * has to become "+4 TB" before it can be written. Making the admin do that
 * subtraction by hand is how a node upgrade turns into a mistyped grant — this
 * takes the target and derives the delta, then appends it like any other entry.
 * History stays intact; nothing is rewritten.
 */
export function SetClaimDialog({
  open,
  onOpenChange,
  userId,
  userEmail,
  nodeId,
  nodeLabel,
  currentGb,
  nodeFreeGb,
  onApplied,
}: Props) {
  const [targetGb, setTargetGb] = useState(currentGb);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const deltaGb = targetGb - currentGb;
  // Growing is bounded by what the node has left; shrinking is bounded at zero,
  // since a user's claim on a node may never go negative.
  const maxTargetGb = currentGb + nodeFreeGb;
  const exceedsNode = deltaGb > nodeFreeGb;
  const belowZero = targetGb < 0;
  const noChange = deltaGb === 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (noChange) {
      toast.error('That is already the current claim — nothing to apply');
      return;
    }
    if (belowZero) {
      toast.error('A claim cannot go below zero');
      return;
    }
    setSubmitting(true);
    try {
      await api('/next-api/garage/claims', {
        method: 'POST',
        body: {
          user_id: userId,
          node_id: nodeId,
          quota_gb: deltaGb,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      });
      toast.success(
        `${userEmail} now claims ${formatStorage(targetGb)} on ${nodeLabel} (${formatSignedStorage(deltaGb)})`
      );
      onOpenChange(false);
      await onApplied();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Adjustment failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Set claim</DialogTitle>
            <DialogDescription>
              Enter what <strong>{userEmail}</strong> should have on{' '}
              <span className="font-mono text-xs">{nodeLabel}</span> after the
              change. The difference is appended to the ledger as a single
              signed entry, so the grant history stays intact.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="set-claim-target">New total</Label>
              <StorageQuotaInput
                id="set-claim-target"
                valueGib={targetGb}
                onChangeGib={setTargetGb}
                minGib={0}
                maxGib={maxTargetGb}
                aria-describedby="set-claim-summary"
              />
            </div>

            <p id="set-claim-summary" className="text-xs text-muted-foreground">
              Current <strong>{formatStorage(currentGb)}</strong> →{' '}
              <strong>{formatStorage(Math.max(targetGb, 0))}</strong> ·
              adjustment{' '}
              <strong
                className={deltaGb < 0 ? 'text-destructive' : undefined}
                data-testid="set-claim-delta"
              >
                {formatSignedStorage(deltaGb)}
              </strong>
              <br />
              Free to grant on this node:{' '}
              <strong>{formatStorage(nodeFreeGb)}</strong>
            </p>

            {exceedsNode && (
              <p className="text-xs text-destructive">
                That is more than the node has left to give — the server will
                reject it.
              </p>
            )}
            {belowZero && (
              <p className="text-xs text-destructive">
                A user&apos;s claim on a node cannot go below zero.
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="set-claim-note">Note (optional)</Label>
              <Input
                id="set-claim-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. upgraded to 8TB disk"
                maxLength={500}
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
              disabled={submitting || noChange || belowZero}
            >
              {submitting ? 'Applying...' : 'Apply'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
