'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { NodeIdentity } from '@/components/cluster/node-identity';
import { LastScrub } from '@/components/admin/last-scrub';
import { describeScrubFreshness } from '@/lib/repair/scrub-freshness';
import type { RepairNodeRow } from '@/hooks/use-repair-data';
import type { NodeStatsItem } from '@/app/next-api/garage/repairs/node-stats/route';

interface Props {
  rows: readonly RepairNodeRow[];
  /** node key → the live statistics reading, when one has arrived. */
  statsByNode: Map<string, NodeStatsItem>;
  /** The workers reading's clock, so ages are "as of the reading". */
  now: number;
}

/**
 * Every node, what its scrub knows, and how far behind its block manager is.
 *
 * **No launch buttons.** The overview reads; the tabs act. That is the existing
 * "a real index, not a redirect" argument carried one step further: these are
 * expensive, multi-day, unstoppable operations, and an operator who arrives
 * cold should pass through the page that explains what a block repair costs
 * before they can start one. (The block-errors card's retry is the one
 * exception on this page, and it is cheap and idempotent.)
 *
 * The resync queue is **not a progress bar** and is never rendered as one — no
 * percentage, no bar, no ETA. It counts blocks this node still has to fetch,
 * it is shared by repair, rebalance and ordinary replication catch-up, and it
 * rises before it falls. A `—` means the node reported no block-manager
 * statistics, which is not the same as an empty queue.
 */
export function RepairOverviewTable({ rows, statsByNode, now }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Node</TableHead>
          <TableHead>Zone</TableHead>
          <TableHead>Last scrub</TableHead>
          <TableHead>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help">Resync queue</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Blocks this node still has to fetch from its peers. It rises
                before it falls, and it is shared by block repair, rebalance and
                ordinary replication catch-up — so it is a sign of movement, not
                a measure of progress.
              </TooltipContent>
            </Tooltip>
          </TableHead>
          <TableHead>Workers</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const w = row.workers;
          const stats = statsByNode.get(row.nodeId) ?? null;
          const freshness = describeScrubFreshness(
            { scrub: w?.scrub ?? null, nodeError: w?.error ?? null },
            now
          );
          return (
            <TableRow key={row.nodeId}>
              <TableCell>
                <NodeIdentity name={row.name} nodeId={row.nodeId} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.zone || '—'}
              </TableCell>
              <TableCell>
                <LastScrub
                  freshness={freshness}
                  nextScheduledAt={w?.scrub?.nextScheduledAt}
                />
              </TableCell>
              <TableCell>
                {stats?.error ? (
                  <span className="text-destructive text-sm">
                    {stats.error}
                  </span>
                ) : stats?.resyncQueueLen == null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={
                        stats.resyncQueueLen > 0 ? 'font-medium' : undefined
                      }
                    >
                      {stats.resyncQueueLen.toLocaleString()}
                    </span>
                    {/* Resync *errors* are the same blocks the Block errors
                        card lists; the count here is the pointer to it. */}
                    {stats.resyncErrors ? (
                      <Badge
                        variant="secondary"
                        className="bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      >
                        {stats.resyncErrors.toLocaleString()} errored
                      </Badge>
                    ) : null}
                  </div>
                )}
              </TableCell>
              <TableCell>
                {/* A node that failed to report its workers shows why. It must
                    never render as "idle" — not knowing is not the same as
                    nothing running. */}
                {w?.error ? (
                  <span className="text-destructive text-sm">{w.error}</span>
                ) : !w ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-muted-foreground text-sm">
                      {w.busyCount > 0 ? `${w.busyCount} busy` : 'idle'}
                    </span>
                    {w.erroredCount > 0 && (
                      <Badge
                        variant="secondary"
                        className="bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      >
                        {w.erroredCount} errored
                      </Badge>
                    )}
                  </div>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
