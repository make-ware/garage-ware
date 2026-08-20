'use client';

import { CheckCircle2, CircleDashed, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCapacity } from '@/lib/format';
import { PARTITION_COUNT, type SimSuccess } from '@/lib/cluster/layout-sim';
import type { BaselineSource } from '@/lib/cluster/layout-baseline';

/**
 * Whether this page's arithmetic agrees with the operator's own cluster.
 *
 * The planner simulates the layout **exactly as it stands** on every load and
 * compares its partition size to the one Garage reports. A match is a live
 * validation of the engine against real hardware, which is worth far more than
 * any assurance in the copy — so it is stated on screen rather than assumed.
 *
 * `staged` suppresses the comparison entirely: with staged role changes
 * pending, Garage's reported `partitionSize` describes the applied layout, and
 * comparing it to anything is meaningless.
 */
export type ConformanceState =
  | { kind: 'match'; partitionSizeBytes: number }
  | { kind: 'mismatch'; garageBytes: number; simulatedBytes: number }
  | { kind: 'staged' }
  | { kind: 'unknown' };

interface PlannerSummaryProps {
  result: SimSuccess;
  /** The unmodified layout, for the before → after column. `null` if infeasible. */
  baselineCapacityBytes: number | null;
  conformance: ConformanceState;
  baselineSource: BaselineSource;
}

function Figure({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

export function PlannerSummary({
  result,
  baselineCapacityBytes,
  conformance,
  baselineSource,
}: PlannerSummaryProps) {
  const { exact, estimated } = result;
  const declared = exact.totalDeclaredBytes;
  const usedShare =
    declared > 0 ? (exact.totalUsableBytes / declared) * 100 : 0;
  const change =
    baselineCapacityBytes === null
      ? null
      : exact.effectiveCapacityBytes - baselineCapacityBytes;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Simulated layout
          <Badge variant="secondary">Exact</Badge>
          <ConformanceBadge conformance={conformance} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Partition size"
            value={formatCapacity(exact.partitionSizeBytes)}
            detail={`${PARTITION_COUNT} partitions`}
          />
          <Figure
            label="Effective capacity"
            value={formatCapacity(exact.effectiveCapacityBytes)}
            detail={
              change === null
                ? 'data the cluster can hold'
                : change === 0
                  ? 'unchanged by this plan'
                  : `${change > 0 ? '+' : '−'}${formatCapacity(Math.abs(change))} vs. now`
            }
          />
          <Figure
            label="Usable of declared"
            value={`${formatCapacity(exact.totalUsableBytes)} / ${formatCapacity(declared)}`}
            detail={`${usedShare.toFixed(1)}% of declared disk is reachable`}
          />
          <Figure
            label="Zone redundancy"
            value={`${exact.effectiveZoneRedundancy} zone${exact.effectiveZoneRedundancy === 1 ? '' : 's'}`}
            detail={`replication factor ${exact.replicationFactor}`}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {estimated.partitionsMoved === null ? (
            <>
              No baseline is available, so this plan&rsquo;s data movement
              cannot be estimated.
            </>
          ) : (
            <>
              <span className="font-medium text-foreground tabular-nums">
                {estimated.partitionsMoved}
              </span>{' '}
              partition{estimated.partitionsMoved === 1 ? '' : 's'} would move —
              about{' '}
              {formatCapacity(
                estimated.partitionsMoved * exact.partitionSizeBytes
              )}{' '}
              of transfer, and a <em>lower bound</em>: a node whose count is
              unchanged can still swap which partitions it holds.
              {baselineSource === 'simulated' &&
                ' Measured against an estimated baseline.'}
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

function ConformanceBadge({ conformance }: { conformance: ConformanceState }) {
  switch (conformance.kind) {
    case 'match':
      return (
        <Badge variant="outline" className="text-emerald-600">
          <CheckCircle2 />
          Matches this cluster
        </Badge>
      );
    case 'mismatch':
      return (
        <Badge variant="outline" className="text-amber-600">
          <TriangleAlert />
          Differs from this cluster
        </Badge>
      );
    case 'staged':
      return (
        <Badge variant="outline" className="text-muted-foreground">
          <CircleDashed />
          Staged changes pending
        </Badge>
      );
    case 'unknown':
      return null;
  }
}
