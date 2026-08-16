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
  /**
   * The submit button's tone. Defaults to `destructive`, which is what every
   * delete call site wants and gets without passing anything.
   *
   * It exists because the type-the-name challenge is not only a delete gate:
   * /admin/repairs uses it to ask "did you mean *this* node" before launching a
   * repair, which is a creative action. A red button is a real signal and
   * spending it on "Start scrub" would devalue it everywhere else.
   */
  variant?: React.ComponentProps<typeof Button>['variant'];
  /** In-flight label. Defaults to `Deleting...` — see `variant`. */
  pendingLabel?: string;
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
  variant = 'destructive',
  pendingLabel = 'Deleting...',
}: Props) {
  // Not a literal id: this dialog stays mounted behind its trigger, so a table
  // rendering one per row would otherwise put N inputs with the same DOM id on
  // the page and break every <Label htmlFor> on it.
  const inputId = React.useId();
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
      toast.error(err instanceof Error ? err.message : 'Action failed');
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
          <Label htmlFor={inputId}>
            Type <span className="font-mono font-semibold">{confirmText}</span>{' '}
            to confirm
          </Label>
          <Input
            id={inputId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <Button
            variant={variant}
            disabled={!matches || submitting}
            onClick={handleConfirm}
          >
            {submitting ? pendingLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
