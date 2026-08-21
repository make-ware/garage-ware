'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { BLOCK_OPERATIONS } from '@/lib/repair/operations';
import type { RetryBlockResyncResponse } from '@/app/next-api/garage/repairs/block-errors/route';

interface Props {
  nodeId: string;
  /** The node's display label — also what the operator has to type. */
  nodeLabel: string;
  errorCount: number;
  onDone: () => void | Promise<void>;
}

/**
 * Ask one node to re-queue every block it failed to fetch.
 *
 * **Behind the same type-the-node-name challenge as a repair launch**, though
 * this operation is cheap and idempotent where those are expensive and
 * multi-day. Two reasons: the question the challenge asks is "did you mean
 * *this* node", which is exactly as easy to get wrong in a table of rows here
 * as it is there; and a second confirmation primitive on the same page would be
 * a new component teaching operators that some buttons in this section are
 * guarded differently from others. `variant="default"`, not destructive —
 * nothing is deleted, and a retry that finds nothing to do costs one queue
 * scan.
 *
 * The button is **not** a `RepairAction`: its copy comes from
 * `BLOCK_OPERATIONS` and it POSTs to the block-errors route, which takes no
 * action parameter at all. See `lib/repair/operations.ts`.
 */
export function RetryResyncButton({
  nodeId,
  nodeLabel,
  errorCount,
  onDone,
}: Props) {
  const [open, setOpen] = useState(false);
  const copy = BLOCK_OPERATIONS['retry-resync'];

  async function retry() {
    const result = await api<RetryBlockResyncResponse>(
      '/next-api/garage/repairs/block-errors',
      { method: 'POST', body: { nodeId, all: true } }
    );
    // "Queued", never "repaired": Garage has put these blocks back in the
    // resync queue, and whether they can be fetched is the next attempt's
    // answer, not this one's.
    const queued = `${result.count.toLocaleString()} block${
      result.count === 1 ? '' : 's'
    } queued for resync on ${nodeLabel}`;
    if (result.logged) {
      toast.success(queued);
    } else {
      toast.warning(`${queued} — but the timeline entry could not be written`);
    }
    await onDone();
  }

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="outline" size="sm">
          {copy.button}
        </Button>
      }
      title={`${copy.button} on ${nodeLabel}?`}
      description={
        <p>
          Garage will put the {errorCount.toLocaleString()} errored block
          {errorCount === 1 ? '' : 's'} on{' '}
          <span className="font-mono font-semibold">{nodeLabel}</span> back in
          its resync queue and try to fetch them from its peers again. It is
          safe to repeat: nothing is deleted, and blocks that still cannot be
          found simply return to this list.
        </p>
      }
      confirmText={nodeLabel}
      confirmLabel={copy.button}
      pendingLabel="Retrying…"
      variant="default"
      onConfirm={retry}
    />
  );
}
