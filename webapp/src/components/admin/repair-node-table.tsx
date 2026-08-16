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
import { NodeIdentity } from '@/components/cluster/node-identity';
import { LaunchRepairButton } from '@/components/admin/launch-repair-button';
import type { RepairNodeRow } from '@/hooks/use-repair-data';
import type { RepairAction } from '@/lib/repair/operations';

interface Props {
  action: RepairAction;
  rows: readonly RepairNodeRow[];
  /** What this repair does, rendered into each node's confirmation dialog. */
  describe: (nodeLabel: string) => React.ReactNode;
  onLaunched: () => Promise<void>;
}

/**
 * A per-node launcher for repairs with no status of their own to report.
 *
 * Blocks and rebalance are near-identical — Garage exposes no progress for
 * either beyond the generic worker list — so they share this rather than
 * growing two tables that would drift.
 *
 * The Workers column is the point of showing worker state on these pages at
 * all: "something is already running here" is the one thing worth knowing
 * before starting a second job that will run for days.
 */
export function RepairNodeTable({ action, rows, describe, onLaunched }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Node</TableHead>
          <TableHead>Zone</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Workers</TableHead>
          <TableHead>Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const w = row.workers;
          return (
            <TableRow key={row.nodeId}>
              <TableCell>
                <NodeIdentity name={row.name} nodeId={row.nodeId} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.zone || '—'}
              </TableCell>
              <TableCell>
                {row.draining ? (
                  <Badge variant="outline">draining</Badge>
                ) : row.isUp === null ? (
                  <span className="text-muted-foreground">unknown</span>
                ) : row.isUp ? (
                  <Badge
                    variant="secondary"
                    className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                  >
                    up
                  </Badge>
                ) : (
                  <Badge variant="destructive">down</Badge>
                )}
              </TableCell>
              <TableCell>
                {/*
                  A node that failed to report its workers shows why. It must
                  never render as "idle" — not knowing is not the same as
                  nothing running.
                */}
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
              <TableCell>
                {/*
                  Stays enabled even when this node's worker read failed:
                  ListWorkers failing says nothing about whether
                  LaunchRepairOperation will.
                */}
                <LaunchRepairButton
                  action={action}
                  nodeId={row.nodeId}
                  nodeLabel={row.label}
                  onLaunched={onLaunched}
                  description={describe(row.label)}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
