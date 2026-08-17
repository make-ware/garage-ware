'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
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
import {
  assessCoverage,
  coverageInputFromMetric,
  MIN_PEER_READINGS,
  type CoverageReason,
  type NodeCoverage,
} from '@/lib/metrics/data-coverage';
import { CATEGORY_LABELS, SEVERITY_LABEL } from '@/lib/cluster-timeline';
import type { ClusterNodeItem, ClusterTimelineEvent } from '@/lib/types';
import { nodeKey, nodeLabel, parseNodeTags } from '@/lib/node-label';
import { cn } from '@/lib/utils';

interface NodeDetailsDialogProps {
  /** The node whose details to show; null closes the dialog. */
  item: ClusterNodeItem | null;
  onClose: () => void;
  replicationFactor: number;
  /** node id → latest NodeMetrics row; null while loading or unavailable. */
  latestMetrics: Map<string, NodeMetric> | null;
  /**
   * node id → open manual notes. Omitting it hides the repair banner entirely,
   * which is what a page that doesn't fetch the timeline wants.
   */
  openEventsByNode?: Map<string, ClusterTimelineEvent[]>;
  /**
   * node id → network address. Only ever passed on the admin page; omitting it
   * hides the address row entirely, since the non-admin payload never carries
   * one.
   */
  addrByNodeId?: Map<string, string | null>;
}

/** One label-over-value cell. Two per row on all but the widest content. */
function Stat({
  label,
  children,
  wide,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn('min-w-0', wide && 'col-span-2')}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t pt-4 first:border-t-0 first:pt-0">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">{children}</dl>
    </section>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** A filesystem partition as used/total with a fill bar. Always full width. */
function PartitionStat({
  label,
  partition,
}: {
  label: string;
  partition: PartitionSample | null;
}) {
  if (!partition) {
    return (
      <Stat label={label} wide>
        <Muted>no partition data</Muted>
      </Stat>
    );
  }
  return (
    <div className="col-span-2 min-w-0">
      <dt className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <QuotaFillPct used={partition.usedBytes} cap={partition.totalBytes} />
      </dt>
      <dd className="text-sm">
        {formatCapacity(partition.usedBytes)} /{' '}
        {formatCapacity(partition.totalBytes)}
        <QuotaFillBar
          used={partition.usedBytes}
          cap={partition.totalBytes}
          className="mt-1"
        />
      </dd>
    </div>
  );
}

/**
 * Why the coverage check declined to judge this node. Short, because it lands
 * in a stat cell — the long-form versions on /dashboard/metrics and
 * /admin/events are paragraphs doing a different job, not copies of this.
 */
const COVERAGE_REASON: Record<CoverageReason, string> = {
  'node-down': 'node is down',
  'layout-unavailable': 'layout unavailable at last sample',
  'no-role': 'gateway — holds no partitions',
  'no-partition-reading': 'no partition reading',
  'too-few-peers': `needs ${MIN_PEER_READINGS} reporting storage nodes`,
  'cluster-too-empty': 'cluster too empty to compare',
};

/**
 * Open manual notes pinned to this node — the "under repair" state, which is
 * one open row and no extra column (see CLAUDE.md, Cluster events).
 *
 * Amber rather than destructive on purpose: a node under repair is a node
 * somebody is already dealing with, which is a different thing from a node
 * that is failing unattended. It sits at the top because it is the one piece
 * of context that changes how everything below it should be read.
 */
function RepairBanner({ events }: { events: ClusterTimelineEvent[] }) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
        Under repair
      </p>
      <ul className="space-y-2">
        {events.map((e) => (
          <li key={e.id}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium">{e.title}</span>
              {e.category && (
                <Badge
                  variant="outline"
                  className="border-amber-500/40 text-amber-700 dark:text-amber-400"
                >
                  {CATEGORY_LABELS[
                    e.category as keyof typeof CATEGORY_LABELS
                  ] ?? e.category}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {/* Absolute, not "open for 4 days": a relative duration means
                  reading the clock during render, which `react-hooks/purity`
                  rejects — correctly, since it makes the render unstable. */}
              Open since {formatPbDateTime(e.occurred_at)} ·{' '}
              {SEVERITY_LABEL[e.severity] ?? e.severity}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Per-node details for the cluster map: identity, live status, capacity, what
 * the node holds of the ring, whether it is holding its share of the data, and
 * the most recent NodeMetrics sample. The sample honors the collection's null
 * conventions via describeSample — a gap renders as a gap, never a zero.
 *
 * Deliberately **not** an event list: an open repair note is state, and it is
 * the only event this dialog knows about. History lives on the timeline.
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
  openEventsByNode,
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

  // Coverage is inherently comparative, so it is computed over *every* node's
  // latest sample and then read for the one on screen — there is no per-node
  // answer to look up. Memoized on the map, not on the selection, so opening a
  // second node costs nothing.
  const coverageByNode = useMemo(() => {
    if (!latestMetrics) return null;
    const result = assessCoverage(
      [...latestMetrics.values()].map(coverageInputFromMetric)
    );
    return {
      byNode: new Map(result.nodes.map((n) => [n.nodeId, n])),
      median: result.medianBytesPerPartition,
    };
  }, [latestMetrics]);

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* Header pinned, body scrolling: a long sample list must not push the
          close button off the top of the dialog. */}
      <DialogContent className="max-h-[85vh] grid-rows-[auto_1fr] gap-0 overflow-hidden p-0 sm:max-w-xl">
        {shown && (
          <NodeDetailsBody
            item={shown}
            replicationFactor={replicationFactor}
            metric={latestMetrics?.get(shown.id) ?? null}
            coverage={coverageByNode?.byNode.get(shown.id) ?? null}
            medianBytesPerPartition={coverageByNode?.median ?? null}
            openEvents={openEventsByNode?.get(shown.id) ?? []}
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
  coverage,
  medianBytesPerPartition,
  openEvents,
  addr,
}: {
  item: ClusterNodeItem;
  replicationFactor: number;
  metric: NodeMetric | null;
  coverage: NodeCoverage | null;
  medianBytesPerPartition: number | null;
  openEvents: ClusterTimelineEvent[];
  addr?: string | null;
}) {
  const usableGib = nodeUsableGbFrom(item.capacity, replicationFactor);
  const diskUsed =
    item.diskTotalBytes !== null && item.diskFreeBytes !== null
      ? item.diskTotalBytes - item.diskFreeBytes
      : null;
  const sample = metric ? describeSample(metric) : null;
  // The name renders as the title, so it must not repeat as a badge.
  const { name, rest } = parseNodeTags(item.tags);
  const underRepair = openEvents.length > 0;

  return (
    <>
      {/* pr-10 keeps the title clear of the dialog's own close button. */}
      <DialogHeader className="gap-1 border-b p-4 pr-10 text-left">
        <DialogTitle className="truncate text-base">
          {nodeLabel(name, item.id)}
        </DialogTitle>
        <DialogDescription className="break-all font-mono text-xs">
          {/* The node key, on every page including the admin ones. There used
              to be a `revealNodeId` prop that showed the full id to admins;
              it was deleted rather than re-plumbed. The full id is the
              credential the node-claim route accepts, an admin who needs one
              reads it from `garage status`, and a render site that exists is a
              render site that can end up on the wrong page. */}
          {nodeKey(item.id)}
        </DialogDescription>
        <div className="flex flex-wrap items-center gap-1 pt-1">
          {item.isUp === null ? (
            <Badge variant="secondary">status unknown</Badge>
          ) : item.isUp ? (
            <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-400">
              up
            </Badge>
          ) : (
            <Badge variant="destructive">down</Badge>
          )}
          {underRepair && (
            <Badge className="bg-amber-500/15 text-amber-700 hover:bg-amber-500/15 dark:text-amber-400">
              under repair
            </Badge>
          )}
          {item.draining && (
            <Badge className="bg-amber-500/15 text-amber-700 hover:bg-amber-500/15 dark:text-amber-400">
              draining
            </Badge>
          )}
          <Badge variant="outline">{item.zone || 'no zone'}</Badge>
          {rest.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      </DialogHeader>

      <div className="space-y-4 overflow-y-auto p-4">
        {underRepair && <RepairBanner events={openEvents} />}

        <Section title="Status">
          <Stat label="Connection">
            {item.isUp === null ? (
              <Muted>unknown</Muted>
            ) : item.isUp ? (
              <span className="text-emerald-500">up</span>
            ) : (
              <span className="text-destructive">down</span>
            )}
          </Stat>
          <Stat label="Last seen">
            {item.lastSeenSecsAgo !== null ? (
              `${item.lastSeenSecsAgo}s ago`
            ) : (
              <Muted>—</Muted>
            )}
          </Stat>
          <Stat label="Garage version">
            {item.garageVersion ?? <Muted>—</Muted>}
          </Stat>
          <Stat label="Layout version">
            {metric?.role_ok && metric.layout_version > 0 ? (
              `v${metric.layout_version}`
            ) : (
              <Muted>—</Muted>
            )}
          </Stat>
          {addr !== undefined && (
            <Stat label="Address" wide>
              <span className="break-all font-mono text-xs">{addr ?? '—'}</span>
            </Stat>
          )}
        </Section>

        <Section title="Capacity">
          <Stat label="Declared">
            {item.capacity !== null ? (
              formatCapacity(item.capacity)
            ) : (
              <Muted>none (gateway node)</Muted>
            )}
          </Stat>
          <Stat label={`Usable at RF ${replicationFactor}`}>
            {usableGib !== null ? (
              formatCapacityGib(usableGib)
            ) : (
              <Muted>—</Muted>
            )}
          </Stat>
          <PartitionStat
            label="Data filesystem"
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
          <PartitionStat
            label="Metadata filesystem"
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

        {/* Ring facts, kept out of "Capacity" on purpose: stored partitions ×
            partition size is Garage's `usableCapacity`, a strictly better
            answer to "how much of this node is usable" than the
            capacity / RF the claim ledger is denominated in. Showing the two
            numbers is useful; multiplying them under a Capacity heading would
            invite substituting it into the invariant. See CLAUDE.md, Node data
            coverage. */}
        <Section title="Ring">
          <Stat label="Partitions held">
            {metric?.layout_ok ? (
              metric.stored_partitions.toLocaleString()
            ) : (
              <Muted>unknown</Muted>
            )}
          </Stat>
          <Stat label="Partition size">
            {metric?.layout_ok && metric.partition_size_bytes > 0 ? (
              formatCapacity(metric.partition_size_bytes)
            ) : (
              <Muted>—</Muted>
            )}
          </Stat>
          <Stat label="Blocks claimed">
            {metric?.node_stats_ok ? (
              metric.rc_entries.toLocaleString()
            ) : (
              <Muted>unknown</Muted>
            )}
          </Stat>
          <Stat label="Data per partition">
            {coverage?.bytesPerPartition !== null &&
            coverage?.bytesPerPartition !== undefined ? (
              formatCapacity(coverage.bytesPerPartition)
            ) : (
              <Muted>—</Muted>
            )}
          </Stat>
        </Section>

        <Section title="Data coverage">
          {!coverage ? (
            <Stat label="Status" wide>
              <Muted>no sample to compare</Muted>
            </Stat>
          ) : coverage.status === 'unknown' ? (
            <Stat label="Not compared" wide>
              <Muted>
                {coverage.reason
                  ? COVERAGE_REASON[coverage.reason]
                  : 'no reading'}
              </Muted>
            </Stat>
          ) : coverage.status === 'ok' ? (
            <Stat label="Status" wide>
              <span className="text-emerald-500">
                holding its share of the data
              </span>
            </Stat>
          ) : (
            <>
              <Stat label="Status" wide>
                <span
                  className={
                    coverage.status === 'missing-data'
                      ? 'text-destructive'
                      : 'text-amber-500'
                  }
                >
                  {coverage.status === 'missing-data'
                    ? 'holding less data than its peers'
                    : 'rebuilding — data still catching up'}
                </span>
              </Stat>
              <Stat label="Shortfall">
                {coverage.dataShortfallPct !== null ? (
                  `${Math.round(coverage.dataShortfallPct * 100)}% below median`
                ) : (
                  <Muted>—</Muted>
                )}
              </Stat>
              <Stat label="Unaccounted for">
                {coverage.missingBytes !== null ? (
                  formatCapacity(coverage.missingBytes)
                ) : (
                  <Muted>—</Muted>
                )}
              </Stat>
            </>
          )}
          {medianBytesPerPartition !== null && (
            <Stat label="Cluster median per partition" wide>
              <Muted>{formatCapacity(medianBytesPerPartition)}</Muted>
            </Stat>
          )}
        </Section>

        <Section title="Latest sample">
          {sample ? (
            <>
              <Stat label="Sampled">{formatPbDateTime(sample.sampledAt)}</Stat>
              <Stat label="Up at sample">
                {sample.isUp ? (
                  'yes'
                ) : (
                  <span className="text-destructive">no</span>
                )}
              </Stat>
              {sample.resync ? (
                <>
                  <Stat label="Resync queue">
                    {sample.resync.queueLength.toLocaleString()}
                  </Stat>
                  <Stat label="Resync errors">
                    {sample.resync.erroredBlocks > 0 ? (
                      <span className="text-destructive">
                        {sample.resync.erroredBlocks.toLocaleString()}
                      </span>
                    ) : (
                      '0'
                    )}
                  </Stat>
                </>
              ) : (
                <Stat label="Resync" wide>
                  <Muted>stats unavailable at last sample</Muted>
                </Stat>
              )}
            </>
          ) : (
            <Stat label="Status" wide>
              <Muted>No samples recorded yet.</Muted>
            </Stat>
          )}
          <p className="col-span-2 pt-1 text-xs text-muted-foreground">
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
