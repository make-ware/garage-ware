'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { NodeIdentity } from '@/components/cluster/node-identity';
import { LaunchRepairButton } from '@/components/admin/launch-repair-button';
import { LastScrub } from '@/components/admin/last-scrub';
import { useRepairData, type RepairNodeRow } from '@/hooks/use-repair-data';
import { SCRUB_ACTIONS } from '@/lib/repair/operations';
import { describeScrubFreshness } from '@/lib/repair/scrub-freshness';
import { formatPbDateTime } from '@/lib/format';

const STATE_TONE: Record<string, string> = {
  busy: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  idle: 'bg-muted text-muted-foreground',
  done: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  throttled: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
};

function ScrubRow({
  row,
  now,
  onLaunched,
}: {
  row: RepairNodeRow;
  /** The reading's clock, from `fetchedAt`. This page never calls `Date.now()`
      during a render — see `lib/repair/scrub-freshness.ts`. */
  now: number;
  onLaunched: () => Promise<void>;
}) {
  const w = row.workers;
  const scrub = w?.scrub ?? null;
  const freshness = describeScrubFreshness(
    { scrub, nodeError: w?.error ?? null },
    now
  );

  return (
    <>
      <TableRow>
        <TableCell>
          <NodeIdentity name={row.name} nodeId={row.nodeId} />
        </TableCell>
        <TableCell className="text-muted-foreground">
          {row.zone || '—'}
        </TableCell>
        <TableCell>
          {w?.error ? (
            <span className="text-destructive text-sm">{w.error}</span>
          ) : (
            <LastScrub
              freshness={freshness}
              nextScheduledAt={scrub?.nextScheduledAt}
            />
          )}
        </TableCell>
        <TableCell>
          {scrub ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className={STATE_TONE[scrub.state]}>
                {scrub.state}
                {scrub.throttledSecs !== null && ` ${scrub.throttledSecs}s`}
              </Badge>
              {scrub.paused && <Badge variant="outline">Paused</Badge>}
              {scrub.progress && (
                <span className="text-muted-foreground text-xs">
                  {scrub.progress}
                </span>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell>
          {/*
            The whole reason to run a scrub. Garage reports it as
            `persistentErrors`, set from its own `corruptions_detected`, and it
            is cumulative — a non-zero count is blocks that failed their
            checksum and needs a human, not a repair button.
          */}
          {scrub?.corruptionsDetected ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help font-medium text-destructive">
                  {scrub.corruptionsDetected.toLocaleString()}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Blocks that failed their checksum on this node, cumulative since
                Garage started counting. A block repair re-fetches corrupt
                blocks from peers.
              </TooltipContent>
            </Tooltip>
          ) : scrub ? (
            <span className="text-muted-foreground">0</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell>
          {scrub?.tranquility !== null && scrub?.tranquility !== undefined ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground cursor-help">
                  {scrub.tranquility}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                How aggressively the scrub throttles itself. Set on the node in
                Garage&apos;s own config — shown here for context, and not
                editable from this app.
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell>
          {scrub ? (
            scrub.errors === 0 && scrub.consecutiveErrors === 0 ? (
              <span className="text-muted-foreground">none</span>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help text-amber-600 dark:text-amber-400">
                    {scrub.errors} ({scrub.consecutiveErrors} in a row)
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  {scrub.lastError
                    ? `${scrub.lastError.message} — ${scrub.lastError.secsAgo}s ago`
                    : 'No detail reported'}
                </TooltipContent>
              </Tooltip>
            )
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell>
          {/*
            All four commands stay enabled whenever the node answered. Deriving
            "which command applies" from a freeform-parsed pause flag would rest
            a control on exactly the precision this page admits it does not
            have, and would strand an operator whose Garage version words the
            line differently. Let Garage refuse; the parsed state beside these
            buttons is information, not a gate.
          */}
          <div className="flex flex-wrap gap-1.5">
            {SCRUB_ACTIONS.map((action) => (
              <LaunchRepairButton
                key={action}
                action={action}
                nodeId={row.nodeId}
                nodeLabel={row.label}
                onLaunched={onLaunched}
                description={
                  <p>
                    A scrub reads every block stored on{' '}
                    <span className="font-mono font-semibold">{row.label}</span>{' '}
                    and verifies it against its checksum. It runs in the
                    background for days to weeks and throttles itself; it does
                    not block reads or writes.
                  </p>
                }
              />
            ))}
          </div>
        </TableCell>
      </TableRow>
      {(scrub?.freeform.length || (w && !w.error && !scrub)) && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={8} className="pt-0">
            {/*
              Always rendered, verbatim. There is no structured last-scrub field
              anywhere in the Garage admin API — these lines are the only place
              that information exists, so a parse we got wrong must still leave
              whatever Garage actually said on screen.
            */}
            {scrub && scrub.freeform.length > 0 && (
              <div className="text-muted-foreground space-y-0.5 font-mono text-xs">
                {!scrub.recognised && (
                  <p className="text-amber-600 dark:text-amber-400">
                    Garage reported this scrub in a format this page does not
                    recognise. The raw lines follow.
                  </p>
                )}
                {scrub.freeform.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            )}
            {w && !w.error && !scrub && (
              <p className="text-muted-foreground text-xs">
                No scrub worker reported — {w.workerNames.length} worker
                {w.workerNames.length === 1 ? '' : 's'} seen
                {w.workerNames.length > 0 && `: ${w.workerNames.join(', ')}`}.
                The worker may be named differently in this Garage version.
              </p>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export default function ScrubRepairPage() {
  const { rows, loading, error, workersUnavailable, fetchedAt, refresh } =
    useRepairData();
  const [refreshing, setRefreshing] = useState(false);
  // One clock for the page, and it is the **reading's**, not the render's:
  // "3 days ago" means three days before Garage answered. `Date.now()` is not
  // an option here anyway — `react-hooks/purity` refuses an impure call during
  // render — and it is not needed: with no reading there is no scrub data
  // either, so every freshness verdict is `node-error` or `no-worker` and none
  // of them carries a date to age.
  const now = Date.parse(fetchedAt ?? '') || 0;

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Scrub</CardTitle>
          <CardDescription>
            A scrub re-reads every block a node stores and checks it against its
            checksum, finding silent corruption that nothing else looks for. It
            is slow and self-throttling by design — a full pass takes days to
            weeks — and Garage runs one automatically about once a month.
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
          className="gap-1.5 shrink-0"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {error && <p className="text-destructive mb-4">{error}</p>}
        {workersUnavailable && (
          <p className="text-muted-foreground mb-4 flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Could not read worker state from the cluster — scrub history is
            unavailable. Repair actions still work.
          </p>
        )}
        {loading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">
            No nodes in the cluster layout.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Node</TableHead>
                <TableHead>Zone</TableHead>
                <TableHead>Last completed scrub</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Corruptions</TableHead>
                <TableHead>Tranquility</TableHead>
                <TableHead>Errors</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <ScrubRow
                  key={row.nodeId}
                  row={row}
                  now={now}
                  onLaunched={handleRefresh}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
