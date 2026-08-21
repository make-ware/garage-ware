'use client';

import { AlertTriangle, CheckCircle2 } from 'lucide-react';
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
import { NodeIdentity } from '@/components/cluster/node-identity';
import { RetryResyncButton } from '@/components/admin/retry-resync-button';
import type {
  BlockErrorNode,
  BlockErrorsResponse,
} from '@/app/next-api/garage/repairs/block-errors/route';

interface Props {
  data: BlockErrorsResponse | null;
  /** Set when the fetch failed outright. Rendered inside the card, not instead of it. */
  error: string | null;
  loading: boolean;
  /** node key → name from its `name:` tag. Resolved live from the layout. */
  nodeNames: Map<string, string | null>;
  onRetried: () => void | Promise<void>;
}

/** How long ago, in the coarsest unit that is still true. */
function agoLabel(secs: number): string {
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

function inLabel(secs: number): string {
  if (secs <= 0) return 'due';
  if (secs < 60) return `in ${secs}s`;
  if (secs < 3600) return `in ${Math.floor(secs / 60)}m`;
  if (secs < 86_400) return `in ${Math.floor(secs / 3600)}h`;
  return `in ${Math.floor(secs / 86_400)}d`;
}

function NodeBlock({
  node,
  nodeNames,
  onRetried,
}: {
  node: BlockErrorNode;
  nodeNames: Map<string, string | null>;
  onRetried: () => void | Promise<void>;
}) {
  const name = nodeNames.get(node.nodeId) ?? null;
  const label = name ?? node.nodeId;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <NodeIdentity name={name} nodeId={node.nodeId} />
          {node.error ? (
            // Never "0 errors": a node that did not answer has told us nothing
            // about its blocks, which is the opposite of a clean bill of health.
            <span className="text-destructive text-sm">{node.error}</span>
          ) : (
            <span className="text-sm">
              {node.totalErrors.toLocaleString()} errored block
              {node.totalErrors === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {/* Offered only where there is something to retry. A retry against a
            node that did not answer would be a guess, and against a clean node
            a no-op with a confirmation dialog. */}
        {!node.error && node.totalErrors > 0 && (
          <RetryResyncButton
            nodeId={node.nodeId}
            nodeLabel={label}
            errorCount={node.totalErrors}
            onDone={onRetried}
          />
        )}
      </div>

      {node.items.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Block</TableHead>
                <TableHead>Failures</TableHead>
                <TableHead>Last tried</TableHead>
                <TableHead>Next try</TableHead>
                <TableHead>Refs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {node.items.map((item) => (
                <TableRow key={item.hash}>
                  <TableCell className="font-mono text-xs">
                    {item.hash}…
                  </TableCell>
                  <TableCell>{item.errorCount.toLocaleString()}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {agoLabel(item.lastTrySecsAgo)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {inLabel(item.nextTryInSecs)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {item.refcount.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {node.truncated && (
            // The cap is rendered, never silent. `ListBlockErrors` has no
            // pagination, so a truncated list that looked complete would read
            // as "25 blocks are broken" when 41,233 are.
            <p className="text-muted-foreground text-xs">
              Showing {node.items.length.toLocaleString()} of{' '}
              {node.totalErrors.toLocaleString()}. Use{' '}
              <span className="font-mono">garage block list-errors</span> on a
              cluster host for the full list.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Blocks a node could not fetch from its peers.
 *
 * **Placed below the per-node table, not above it.** This card is a finding,
 * and on a healthy cluster it says nothing — an empty card at the top of the
 * page is the same mistake as the timeline's column of "No events", scaffolding
 * that drowns what it frames.
 *
 * Two things it must never do: render a node that failed to answer as having
 * zero errors, and present its row order as Garage's. `ListBlockErrors`
 * guarantees no ordering; the sort is this app's, and the description says so.
 */
export function BlockErrorsCard({
  data,
  error,
  loading,
  nodeNames,
  onRetried,
}: Props) {
  const nodes = data?.items ?? [];
  const totalErrors = nodes.reduce((sum, n) => sum + n.totalErrors, 0);
  const unreadable = nodes.filter((n) => n.error).length;
  // A 403 from Garage means the admin token predates this release. The route
  // names the operation in its message; keying the copy on that is what turns a
  // generic red bar into an actionable one.
  const scopeProblem = error?.includes('ListBlockErrors') ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Block errors</CardTitle>
        <CardDescription>
          Blocks a node holds a reference to but could not fetch from its peers.
          Garage retries these on its own schedule; a retry here re-queues them
          immediately. Rows are ordered by soonest retry, then by failure count
          — that ordering is this page&rsquo;s, not Garage&rsquo;s.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : error ? (
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className={scopeProblem ? '' : 'text-destructive'}>{error}</p>
          </div>
        ) : nodes.length === 0 || totalErrors + unreadable === 0 ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            No block errors.
          </p>
        ) : (
          nodes
            .filter((n) => n.error || n.totalErrors > 0)
            .map((node) => (
              <NodeBlock
                key={node.nodeId}
                node={node}
                nodeNames={nodeNames}
                onRetried={onRetried}
              />
            ))
        )}
      </CardContent>
    </Card>
  );
}
