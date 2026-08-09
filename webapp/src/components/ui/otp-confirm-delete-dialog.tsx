'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { OtpGatedDialog } from '@/components/auth/otp-gated-dialog';
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  trigger: React.ReactNode;
  title: string;
  description: React.ReactNode;
  confirmText: string;
  confirmLabel?: string;
  otpActionLabel: string;
  onConfirm: () => Promise<void>;
}

// Destructive-action dialog that requires OTP verification before showing the
// type-to-confirm step. Both stages live in a single Radix Dialog so focus
// management never has to hand off between two modal instances.
export function OtpConfirmDeleteDialog({
  trigger,
  title,
  description,
  confirmText,
  confirmLabel = 'Delete',
  otpActionLabel,
  onConfirm,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  // Clear the challenge on the way out; the dialog stays mounted behind its
  // trigger, so this belongs on the close event rather than in an effect.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setTyped('');
      setSubmitting(false);
    }
    setOpen(next);
  }

  async function handleConfirm() {
    setSubmitting(true);
    try {
      await onConfirm();
      handleOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
      setSubmitting(false);
    }
  }

  const matches = typed === confirmText;

  return (
    <OtpGatedDialog
      open={open}
      onOpenChange={handleOpenChange}
      actionLabel={otpActionLabel}
      trigger={trigger}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription asChild>
          <div className="space-y-2">{description}</div>
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="otp-confirm-delete-input">
          Type <span className="font-mono font-semibold">{confirmText}</span> to
          confirm
        </Label>
        <Input
          id="otp-confirm-delete-input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <DialogFooter>
        <Button
          variant="outline"
          onClick={() => handleOpenChange(false)}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={!matches || submitting}
          onClick={handleConfirm}
        >
          {submitting ? 'Deleting...' : confirmLabel}
        </Button>
      </DialogFooter>
    </OtpGatedDialog>
  );
}
