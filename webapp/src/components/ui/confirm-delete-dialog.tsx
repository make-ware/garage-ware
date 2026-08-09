'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  trigger?: React.ReactNode;
  title: string;
  description: React.ReactNode;
  confirmText: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ConfirmDeleteDialog({
  trigger,
  title,
  description,
  confirmText,
  confirmLabel = 'Delete',
  onConfirm,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: Props) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = isControlled
    ? (controlledOnOpenChange ?? (() => {}))
    : setInternalOpen;
  const [typed, setTyped] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  // Clear the challenge on the way out. The dialog stays mounted behind its
  // trigger, so this rides on the close event rather than an effect watching
  // `open` — which also keeps it correct when the parent controls `open`.
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
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="confirm-delete-input">
            Type <span className="font-mono font-semibold">{confirmText}</span>{' '}
            to confirm
          </Label>
          <Input
            id="confirm-delete-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={!matches || submitting}
            onClick={handleConfirm}
          >
            {submitting ? 'Deleting...' : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
