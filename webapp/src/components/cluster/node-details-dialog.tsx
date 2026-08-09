'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { NodeMetric } from '@garage-ware/shared';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { QuotaFillBar, QuotaFillPct } from '@/components/storage/quota-fill';
import {
  formatCapacity,
  formatCapacityGib,
  formatPbDateTime,
} from '@/lib/format';
import { nodeUsableGbFrom } from '@/lib/storage/ledger-math';
import {
  describeSample,
  type PartitionSample,
} from '@/lib/metrics/node-sample';
import type { ClusterNodeItem } from '@/lib/types';
import { nodeLabelFor } from './cluster-groups';

interface NodeDetailsDialogProps {
  /** The node whose details to show; null closes the dialog. */
  item: ClusterNodeItem | null;
  onClose: () => void;
  replicationFactor: number;
  /** node id → latest NodeMetrics row; null while loading or unavailable. */
  latestMetrics: Map<string, NodeMetric> | null;
  /**
   * node id → network address. Only ever passed on the admin page; omitting it
   * hides the address row entirely, since the non-admin payload never carries
   * one.
   */
  addrByNodeId?: Map<string, string | null>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <dl className="space-y-2">{children}</dl>
    </section>
  );
}

function PartitionRows({
  label,
  partition,
}: {
  label: string;
  partition: PartitionSample | null;
}) {
  if (!partition) {
    return (
      <Row label={label}>
        <span className="text-muted-foreground">no partition data</span>
      </Row>
    );
  }
  return (
    <div className="space-y-1">
      <Row label={label}>
        {formatCapacity(partition.usedBytes)} /{' '}
        {formatCapacity(partition.totalBytes)}
        <QuotaFillPct used={partition.usedBytes} cap={partition.totalBytes} />
      </Row>
      <QuotaFillBar used={partition.usedBytes} cap={partition.totalBytes} />
    </div>
  );
}

/**
 * Per-node details for the cluster map: identity, live status, capacity, and
 * the most recent NodeMetrics sample. The sample honors the collection's null
 * conventions via describeSample — a gap renders as a gap, never a zero.
 *
 * A dialog rather than the panel that used to sit inside the map's frame: with
 * the map now a plain responsive grid, there is no fixed canvas for a panel to
 * share width with, and a side panel would have had to become an overlay on
 * every narrow screen anyway. The dialog is the app's convention for this and
 * brings focus trapping, Escape, and scroll locking with it.
 */
export function NodeDetailsDialog({
  item,
  onClose,
  replicationFactor,
  latestMetrics,
  addrByNodeId,
}: NodeDetailsDialogProps) {
  // Selection clears the instant the dialog is dismissed, but Radix keeps the
  // content mounted through its fade-out — so render the last node rather than
  // letting the box empty itself mid-animation. React's own "adjust state
  // during render" pattern: the extra render happens before the browser paints,
  // and an effect here would flash the new node's details in the old dialog.
  // Taking the maps rather than a pre-resolved metric/addr is what keeps the
  // content whole: both are looked up from the node actually being shown.
  const [shown, setShown] = useState(item);
  if (item !== null && item !== shown) setShown(item);

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* Header pinned, body scrolling: a long sample list must not push the
          close button off the top of the dialog. */}
      <DialogContent className="max-h-[85vh] grid-rows-[auto_1fr] gap-0 overflow-hidden p-0 sm:max-w-lg">
        {shown && (
          <NodeDetailsBody
            item={shown}
            replicationFactor={replicationFactor}
            metric={latestMetrics?.get(shown.id) ?? null}
            addr={
              addrByNodeId ? (addrByNodeId.get(shown.id) ?? null) : undefined
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NodeDetailsBody({
  item,
  replicationFactor,
  metric,
  addr,
}: {
  item: ClusterNodeItem;
  replicationFactor: number;
  metric: NodeMetric | null;
  addr?: string | null;
}) {
  const usableGib = nodeUsableGbFrom(item.capacity, replicationFactor);
  const diskUsed =
    item.diskTotalBytes !== null && item.diskFreeBytes !== null
      ? item.diskTotalBytes - item.diskFreeBytes
      : null;
  const sample = metric ? describeSample(metric) : null;

  return (
    <>
      {/* pr-10 keeps the title clear of the dialog's own close button. */}
      <DialogHeader className="gap-1 border-b p-4 pr-10 text-left">
        <DialogTitle className="truncate text-base">
          {nodeLabelFor(item)}
        </DialogTitle>
        <DialogDescription className="break-all font-mono text-xs">
          {item.id}
        </DialogDescription>
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <Badge variant="outline">{item.zone || 'no zone'}</Badge>
          {item.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      </DialogHeader>

      <div className="space-y-6 overflow-y-auto p-4">
        <Section title="Status">
          <Row label="Connection">
            {item.isUp === null ? (
              <span className="text-muted-foreground">unknown</span>
            ) : item.isUp ? (
              <span className="text-emerald-500">up</span>
            ) : (
              <span className="text-destructive">down</span>
            )}
          </Row>
          {item.draining && (
            <Row label="Draining">
              <span className="text-amber-500">yes</span>
            </Row>
          )}
          {item.lastSeenSecsAgo !== null && (
            <Row label="Last seen">{item.lastSeenSecsAgo}s ago</Row>
          )}
          {item.garageVersion && (
            <Row label="Garage version">{item.garageVersion}</Row>
          )}
          {addr !== undefined && (
            <Row label="Address">
              <span className="break-all font-mono text-xs">{addr ?? '—'}</span>
            </Row>
          )}
        </Section>

        <Section title="Capacity">
          <Row label="Declared">
            {item.capacity !== null ? (
              formatCapacity(item.capacity)
            ) : (
              <span className="text-muted-foreground">none (gateway node)</span>
            )}
          </Row>
          {usableGib !== null && (
            <Row label={`Usable at RF ${replicationFactor}`}>
              {formatCapacityGib(usableGib)}
            </Row>
          )}
          <PartitionRows
            label="Data partition"
            partition={
              item.diskTotalBytes !== null && diskUsed !== null
                ? {
                    totalBytes: item.diskTotalBytes,
                    availableBytes: item.diskFreeBytes ?? 0,
                    usedBytes: diskUsed,
                  }
                : null
            }
          />
          <PartitionRows
            label="Metadata partition"
            partition={
              item.metaTotalBytes !== null && item.metaFreeBytes !== null
                ? {
                    totalBytes: item.metaTotalBytes,
                    availableBytes: item.metaFreeBytes,
                    usedBytes: item.metaTotalBytes - item.metaFreeBytes,
                  }
                : null
            }
          />
        </Section>

        <Section title="Latest sample">
          {sample ? (
            <>
              <Row label="Sampled">{formatPbDateTime(sample.sampledAt)}</Row>
              <Row label="Up at sample">
                {sample.isUp ? (
                  'yes'
                ) : (
                  <span className="text-destructive">no</span>
                )}
              </Row>
              <PartitionRows label="Data" partition={sample.dataPartition} />
              <PartitionRows
                label="Metadata"
                partition={sample.metaPartition}
              />
              {sample.resync ? (
                <>
                  <Row label="Resync queue">
                    {sample.resync.queueLength.toLocaleString()}
                  </Row>
                  <Row label="Resync errors">
                    {sample.resync.erroredBlocks > 0 ? (
                      <span className="text-destructive">
                        {sample.resync.erroredBlocks.toLocaleString()}
                      </span>
                    ) : (
                      '0'
                    )}
                  </Row>
                </>
              ) : (
                <Row label="Resync">
                  <span className="text-muted-foreground">
                    stats unavailable at last sample
                  </span>
                </Row>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No samples recorded yet.
            </p>
          )}
          <p className="pt-2 text-xs text-muted-foreground">
            Sampled every 15 minutes ·{' '}
            <Link
              href="/dashboard/metrics"
              className="underline underline-offset-2 hover:text-foreground"
            >
              view history
            </Link>
          </p>
        </Section>
      </div>
    </>
  );
}
