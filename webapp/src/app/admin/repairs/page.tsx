'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { ArrowRight, Blocks, RefreshCw, ScanSearch, Scale } from 'lucide-react';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BlockErrorsCard } from '@/components/admin/block-errors-card';
import { RepairHistoryCard } from '@/components/admin/repair-history-card';
import { RepairOverviewTable } from '@/components/admin/repair-overview-table';
import { useBlockErrors } from '@/hooks/use-block-errors';
import { useNodeStatsPoll } from '@/hooks/use-node-stats-poll';
import { useRepairData } from '@/hooks/use-repair-data';
import { describeScrubFreshness, isStale } from '@/lib/repair/scrub-freshness';
import { formatPbDateTime } from '@/lib/format';

/**
 * A real index, not a redirect to /scrub.
 *
 * These are expensive, multi-day, unstoppable operations, and a redirect would
 * drop an admin who arrived cold straight in front of a Start button with no
 * idea what it costs. The copy below is the only warning they get; don't cut it
 * for brevity.
 */
const OPERATIONS = [
  {
    href: '/admin/repairs/scrub',
    icon: ScanSearch,
    title: 'Scrub',
    body: 'Re-reads every block a node stores and verifies it against its checksum, finding silent corruption nothing else looks for. Takes days to weeks, throttles itself, and can be paused. Garage runs one automatically about once a month.',
  },
  {
    href: '/admin/repairs/blocks',
    icon: Blocks,
    title: 'Block repair',
    body: 'Walks every block reference a node should hold and re-fetches what is missing from its peers. This is what you run after replacing a drive. Takes hours to days and cannot be paused.',
  },
  {
    href: '/admin/repairs/rebalance',
    icon: Scale,
    title: 'Rebalance',
    body: 'Moves stored blocks to where the current layout says they belong. Run it after adding a node or changing a capacity, once the layout is applied. Takes hours to days and cannot be paused.',
  },
];

/**
 * The operations console: what the cluster's maintenance state is, and what has
 * been done to it.
 *
 * **Card order is deliberate, top to bottom.** Cluster worker state (the
 * summary an operator came for), the per-node table (the detail behind it),
 * block errors (a *finding*, and empty on a healthy cluster — an empty card at
 * the top is the "column of No events" mistake), the three operation cards
 * (unchanged), and the history last, because it is a log.
 *
 * **Nothing here launches a repair.** The overview reads; the tabs act — see
 * `RepairOverviewTable`. The block-errors retry is the one exception and is
 * cheap and idempotent.
 */
export default function RepairsOverviewPage() {
  const { rows, loading, error, workersUnavailable, fetchedAt, refresh } =
    useRepairData();
  const blockErrors = useBlockErrors();
  const [refreshing, setRefreshing] = useState(false);
  const [historyToken, setHistoryToken] = useState(0);

  const busyNodes = rows.filter((r) => (r.workers?.busyCount ?? 0) > 0).length;
  const erroredNodes = rows.filter(
    (r) => (r.workers?.erroredCount ?? 0) > 0
  ).length;

  // One clock for the page, and it is the **reading's**, not the render's:
  // "3 days ago" means three days before Garage answered. `Date.now()` is not
  // an option here anyway — `react-hooks/purity` refuses an impure call during
  // render — and it is not needed: with no reading there is no scrub data
  // either, so every freshness verdict is `node-error` or `no-worker` and none
  // of them carries a date to age.
  const now = Date.parse(fetchedAt ?? '') || 0;
  const staleNodes = rows.filter((r) =>
    isStale(
      describeScrubFreshness(
        {
          scrub: r.workers?.scrub ?? null,
          nodeError: r.workers?.error ?? null,
        },
        now
      )
    )
  ).length;

  // Half the poll's trigger. The other half — a non-empty resync queue — is the
  // hook's own business, because only it has read the queues; it is also the
  // self-limiting half, since a node may carry a permanently busy worker while
  // a queue that drains is an unambiguous stop.
  const { statsByNode, polling, lastPolledAt, stoppedReason } =
    useNodeStatsPoll({ busyWorkers: busyNodes > 0 });

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refresh(), blockErrors.refresh()]);
      setHistoryToken((t) => t + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, [refresh, blockErrors]);

  const nodeNames = new Map(rows.map((r) => [r.nodeId, r.name]));
  const queuedBlocks = [...statsByNode.values()].reduce(
    (sum, s) => sum + (s.resyncQueueLen ?? 0),
    0
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Cluster worker state</CardTitle>
            <CardDescription>
              What is running right now — worth checking before starting
              anything that will run for days.
              {fetchedAt && (
                <> Worker state read {formatPbDateTime(fetchedAt)}.</>
              )}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing || loading}
            className="shrink-0 gap-1.5"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-destructive">{error}</p>}
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : workersUnavailable ? (
            <p className="text-muted-foreground text-sm">
              Could not read worker state from the cluster.
            </p>
          ) : (
            <div className="flex flex-wrap gap-8">
              <div>
                <div className="text-2xl font-semibold">{busyNodes}</div>
                <div className="text-muted-foreground text-sm">
                  {busyNodes === 1 ? 'node' : 'nodes'} with a busy worker
                </div>
              </div>
              <div>
                <div className="text-2xl font-semibold">{erroredNodes}</div>
                <div className="text-muted-foreground text-sm">
                  {erroredNodes === 1 ? 'node' : 'nodes'} with a worker in error
                </div>
              </div>
              <div>
                <div className="text-2xl font-semibold">{staleNodes}</div>
                <div className="text-muted-foreground text-sm">
                  {staleNodes === 1 ? 'node' : 'nodes'} with a stale scrub
                </div>
              </div>
              {queuedBlocks > 0 && (
                <div>
                  <div className="text-2xl font-semibold">
                    {queuedBlocks.toLocaleString()}
                  </div>
                  <div className="text-muted-foreground text-sm">
                    blocks queued for resync
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {polling && (
              <Badge
                variant="secondary"
                className="bg-blue-500/15 text-blue-700 dark:text-blue-400"
              >
                Live
              </Badge>
            )}
            {polling && lastPolledAt && (
              <span className="text-muted-foreground text-xs">
                resync queue updated {formatPbDateTime(lastPolledAt)}
              </span>
            )}
            {stoppedReason === 'errors' && (
              <span className="text-muted-foreground text-xs">
                Live updates stopped after three failed reads. Refresh to
                resume.
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Nodes</CardTitle>
          <CardDescription>
            Per-node maintenance state. Start an operation from its own tab —
            each one explains what it costs before it offers a button.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground">
              No nodes in the cluster layout.
            </p>
          ) : (
            <RepairOverviewTable
              rows={rows}
              statsByNode={statsByNode}
              now={now}
            />
          )}
        </CardContent>
      </Card>

      <BlockErrorsCard
        data={blockErrors.data}
        error={blockErrors.error}
        loading={blockErrors.loading}
        nodeNames={nodeNames}
        onRetried={handleRefresh}
      />

      <div className="grid gap-4 md:grid-cols-3">
        {OPERATIONS.map(({ href, icon: Icon, title, body }) => (
          <Card key={href} className="flex flex-col">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Icon className="h-4 w-4" />
                {title}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col justify-between gap-4">
              <p className="text-muted-foreground text-sm">{body}</p>
              <Link href={href}>
                <Button variant="outline" size="sm" className="gap-1.5">
                  Open <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>

      <RepairHistoryCard nodeNames={nodeNames} refreshToken={historyToken} />
    </div>
  );
}
