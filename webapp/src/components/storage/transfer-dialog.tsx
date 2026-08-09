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
import { formatStorage } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Capacity the sender may still give away, in GiB. */
  availableGb: number;
  /** Already promised to pending invites and not yet paid, in GiB. */
  promisedGb?: number;
  /** Called after a successful send so the parent can refresh. */
  onSent: () => void | Promise<void>;
}

/**
 * Hand part of your unallocated storage to someone else.
 *
 * One form for both outcomes, because from the sender's side there is only one
 * intent. The server decides which it is: an address that already has an
 * account gets a StorageTransfer immediately, one that does not gets a
 * StorageInvite plus an email, and the transfer is created when they sign up.
 * Asking the sender to know which case they are in would be asking them to
 * know something about the recipient that is none of their business.
 */
export function TransferDialog({
  open,
  onOpenChange,
  availableGb,
  promisedGb = 0,
  onSent,
}: Props) {
  const [email, setEmail] = useState('');
  const [amountGb, setAmountGb] = useState(0);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Clear on the way out, so a cancelled attempt is not half-remembered the
  // next time it opens. The dialog stays mounted between opens, so this rides
  // on the close event rather than an effect watching `open`.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setEmail('');
      setAmountGb(0);
      setNote('');
    }
    onOpenChange(next);
  }

  // Pending invites promise capacity without reserving it, so the server takes
  // them off the top. Show the same figure the server will check against.
  const sendableGb = Math.max(availableGb - promisedGb, 0);

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email.trim()) {
      toast.error('Recipient email is required');
      return;
    }
    if (!Number.isFinite(amountGb) || amountGb <= 0) {
      toast.error('Enter a valid amount');
      return;
    }

    setSubmitting(true);
    try {
      const result = await api<{ kind: 'transfer' | 'invite' }>(
        '/next-api/garage/transfers',
        {
          method: 'POST',
          body: {
            to_user_email: email.trim(),
            quota_gb: amountGb,
            note: note.trim() || undefined,
          },
        }
      );
      toast.success(
        result.kind === 'invite'
          ? `Invite sent to ${email.trim()} — the storage lands when they sign up`
          : `${formatStorage(amountGb)} transferred to ${email.trim()}`
      );
      handleOpenChange(false);
      await onSent();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Transfer failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Transfer storage</DialogTitle>
            <DialogDescription>
              Give part of your unallocated storage to someone else. If they
              don&apos;t have an account yet we&apos;ll email them an invite,
              and the storage arrives when they sign up.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="transfer-email">Recipient email</Label>
              <Input
                id="transfer-email"
                type="email"
                placeholder="colleague@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="transfer-amount">Amount</Label>
              <StorageQuotaInput
                id="transfer-amount"
                valueGib={amountGb}
                onChangeGib={setAmountGb}
                maxGib={sendableGb}
                min={0.001}
                required
              />
              <p className="text-xs text-muted-foreground">
                {formatStorage(sendableGb)} available to give
                {promisedGb > 0 && (
                  <>
                    {' '}
                    — {formatStorage(promisedGb)} is promised to open invites
                  </>
                )}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="transfer-note">Note (optional)</Label>
              <Input
                id="transfer-note"
                placeholder="What's this for?"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || sendableGb <= 0}>
              {submitting ? 'Sending…' : 'Send storage'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
