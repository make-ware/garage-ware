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
import { nodeKey, nodeLabel } from '@/lib/node-label';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The recipient's PB id when the caller can resolve one — admins can, because
   * the Users listRule is self-or-admin. Omit it and `userEmail` is sent
   * instead for the server to resolve as a superuser, which is the only form
   * available to a node owner granting to somebody they cannot look up.
   */
  userId?: string;
  /**
   * The recipient's address. With `userId` present this is display only; with
   * it absent the field becomes editable and this seeds it.
   */
  userEmail: string;
  nodeId: string;
  /** The node's name, or null when no `name:` tag supplies one. */
  nodeName: string | null;
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
  nodeName,
  currentGb,
  nodeFreeGb,
  onApplied,
}: Props) {
  const [targetGb, setTargetGb] = useState(currentGb);
  const [note, setNote] = useState('');
  const [email, setEmail] = useState(userEmail);
  const [submitting, setSubmitting] = useState(false);

  // Resolving by address is the node-owner path: the Users listRule is
  // self-or-admin, so a non-admin cannot turn an address into an id from the
  // browser. The server does it as a superuser and 404s on an unknown one.
  const byEmail = !userId;
  const recipient = byEmail ? email.trim() : userEmail;

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
          ...(userId ? { user_id: userId } : { user_email: recipient }),
          node_id: nodeId,
          quota_gb: deltaGb,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      });
      // Two nodes can carry the same name, and this toast reports a mutation
      // against one specific node id — so when a name is shown, the short id
      // is shown with it.
      const named = nodeName
        ? `${nodeName} (${nodeKey(nodeId)})`
        : nodeKey(nodeId);
      // Two modes, two true sentences. Setting a claim knows the recipient's
      // position, so it can report the new total. Granting by address does not
      // — `currentGb` is 0 because nobody has resolved the address yet, which
      // makes `targetGb` the amount *added*, not what they now hold. Reporting
      // it as a total told an owner that a 2 TB grant to somebody already
      // holding 5 TB had left them with 2 TB, inviting a "correction" that
      // would take real storage away.
      toast.success(
        byEmail
          ? `Granted ${formatStorage(deltaGb)} to ${recipient} from ${named}`
          : `${recipient} now claims ${formatStorage(targetGb)} on ${named} (${formatSignedStorage(deltaGb)})`
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
            <DialogTitle>{byEmail ? 'Grant storage' : 'Set claim'}</DialogTitle>
            <DialogDescription>
              {byEmail ? (
                <>
                  How much to grant{' '}
                  <strong>{recipient || 'the recipient'}</strong> from{' '}
                  <strong>{nodeLabel(nodeName, nodeId)}</strong>. It is appended
                  to the ledger as one signed entry, on top of whatever they
                  already hold on this node.
                </>
              ) : (
                <>
                  Enter what <strong>{recipient}</strong> should have on{' '}
                  <strong>{nodeLabel(nodeName, nodeId)}</strong> after the
                  change. The difference is appended to the ledger as a single
                  signed entry, so the grant history stays intact.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {byEmail && (
              <div className="space-y-2">
                <Label htmlFor="set-claim-email">Recipient email</Label>
                <Input
                  id="set-claim-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="them@example.com"
                  autoComplete="off"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  They must already have an account. To reach someone who does
                  not, grant the storage to yourself and send it on from your
                  dashboard.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="set-claim-target">
                {byEmail ? 'Amount to grant' : 'New total'}
              </Label>
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
              {/* No "current" when granting by address: the recipient is not
                  resolved until the server does it, so their existing claim on
                  this node is unknown here. */}
              {!byEmail && (
                <>
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
                </>
              )}
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
              disabled={
                submitting || noChange || belowZero || (byEmail && !recipient)
              }
            >
              {submitting ? 'Applying...' : 'Apply'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
