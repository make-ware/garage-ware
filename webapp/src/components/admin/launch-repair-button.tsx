'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { REPAIR_ACTIONS, type RepairAction } from '@/lib/repair/operations';

interface Props {
  action: RepairAction;
  nodeId: string;
  /** The node's display label — also what the operator has to type. */
  nodeLabel: string;
  /** What this repair does to this node, shown in the dialog. */
  description: React.ReactNode;
  onLaunched: () => void | Promise<void>;
  size?: 'sm' | 'default';
  variant?: React.ComponentProps<typeof Button>['variant'];
}

/**
 * One repair, one node, behind a type-the-node-name challenge.
 *
 * **The challenge asks "did you mean *this* node".** That is the question that
 * matters here and the one an OTP does nothing about — the same reasoning the
 * quota dialog uses. Launching an expensive multi-day operation on the wrong
 * row is the mistake available, not a stolen session.
 *
 * The gate is a React boolean and is **not server-enforced**: a `curl` with an
 * ordinary admin session bypasses it, as it does every other gate in this app.
 * It guards against a careless click.
 *
 * Cancelling a scrub is the one destructive variant — it discards the progress
 * a scrub has made — so callers pass `variant="destructive"` for that alone
 * rather than spending a red button on every launch.
 */
export function LaunchRepairButton({
  action,
  nodeId,
  nodeLabel,
  description,
  onLaunched,
  size = 'sm',
  variant = 'outline',
}: Props) {
  const [open, setOpen] = useState(false);
  const copy = REPAIR_ACTIONS[action];

  async function launch() {
    const result = await api<{ ok: true; logged: boolean }>(
      '/next-api/garage/repairs',
      { method: 'POST', body: { nodeId, action } }
    );
    if (result.logged) {
      toast.success(`${copy.launched} on ${nodeLabel}`);
    } else {
      // The repair ran; only the timeline entry didn't. Say both, because an
      // operator who reads "failed" will click again.
      toast.warning(
        `${copy.launched} on ${nodeLabel} — but the timeline entry could not be written`
      );
    }
    await onLaunched();
  }

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant={variant} size={size}>
          {copy.button}
        </Button>
      }
      title={`${copy.button} on ${nodeLabel}?`}
      description={description}
      confirmText={nodeLabel}
      confirmLabel={copy.button}
      pendingLabel="Launching…"
      variant={action === 'scrub-cancel' ? 'destructive' : 'default'}
      onConfirm={launch}
    />
  );
}
