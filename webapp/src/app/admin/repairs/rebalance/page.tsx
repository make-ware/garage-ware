'use client';

import { RepairLauncherPage } from '@/components/admin/repair-launcher-page';

export default function RebalanceRepairPage() {
  return (
    <RepairLauncherPage
      action="rebalance"
      title="Rebalance"
      description={
        <>
          Moves stored blocks to where the current layout says they belong. Run
          it after a layout change — adding a node, changing a capacity, or
          altering zone redundancy — once the layout has been applied. Garage
          exposes no progress for it beyond the worker list below.
        </>
      }
      describe={(label) => (
        <p>
          A rebalance moves blocks on{' '}
          <span className="font-mono font-semibold">{label}</span> to match the
          current cluster layout. It runs in the background for hours to days,
          cannot be paused or stopped from this app, and moves a large amount of
          data across the cluster.
        </p>
      )}
    />
  );
}
