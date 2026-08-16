'use client';

import { RepairLauncherPage } from '@/components/admin/repair-launcher-page';

export default function BlocksRepairPage() {
  return (
    <RepairLauncherPage
      action="blocks"
      title="Block repair"
      description={
        <>
          Walks every block reference this node should hold and re-fetches
          whatever is missing from its peers. This is what you run after
          replacing a drive, or when a node reports a data shortfall against its
          peers. Garage exposes no progress for it beyond the worker list below.
        </>
      }
      describe={(label) => (
        <p>
          A block repair walks every block reference on{' '}
          <span className="font-mono font-semibold">{label}</span> and
          re-fetches what is missing from its peers. It runs in the background
          for hours to days, cannot be paused or stopped from this app, and will
          use significant disk and network on both this node and the ones it
          pulls from.
        </p>
      )}
    />
  );
}
