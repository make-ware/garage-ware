'use client';

import { useEffect, useMemo, useReducer, useState } from 'react';
import { Info, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { NodeMetric } from '@garage-ware/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { PlannerCommands } from '@/components/cluster/planner-commands';
import { PlannerNodeTable } from '@/components/cluster/planner-node-table';
import {
  PlannerSummary,
  type ConformanceState,
} from '@/components/cluster/planner-summary';
import { PlannerZoneTable } from '@/components/cluster/planner-zone-table';
import { api } from '@/lib/api-client';
import pb from '@/lib/pocketbase';
import { fetchLatestNodeMetrics } from '@/lib/metrics/latest-node-metrics';
import { formatCapacity } from '@/lib/format';
import {
  BASELINE_REJECTION_COPY,
  resolveBaseline,
} from '@/lib/cluster/layout-baseline';
import {
  capacityImpact,
  diffDraft,
  draftCommands,
  draftErrors,
  draftFromLive,
  draftReducer,
  parseZoneRedundancy,
  toSimNodes,
  type LayoutDraft,
} from '@/lib/cluster/layout-draft';
import { simulateLayout, type SimResult } from '@/lib/cluster/layout-sim';
import {
  APPROXIMATION_DISCLAIMER,
  failureMessage,
  NO_WRITE_NOTICE,
  STAGED_CHANGES_NOTICE,
  warningBody,
  warningTitle,
} from '@/lib/cluster/planner-copy';
import type { LayoutResponse } from '@/lib/admin-types';

/**
 * The cluster layout planner: what Garage would do with a set of nodes, worked
 * out entirely in the browser.
 *
 * **It makes no Garage mutations and adds no endpoints.** It reads the layout
 * through the display route the admin console already uses, and the movement
 * baseline out of `NodeMetrics`, which the scrape cron already fills. Garage's
 * own `PreviewClusterLayoutChanges` only operates on *staged* changes and
 * `RevertClusterLayout` clears staging by incrementing the layout version, so a
 * preview built on it would leave a permanent mark on the cluster. Everything
 * below is arithmetic — see `lib/cluster/layout-sim.ts`.
 *
 * Recomputation is a `useMemo` over the draft: no fetch, no debounce, no
 * request per keystroke.
 */

const EMPTY_DRAFT: LayoutDraft = {
  nodes: [],
  replicationFactor: 3,
  zoneRedundancy: { mode: 'maximum' },
  nextKey: 1,
};

export default function ClusterPlannerPage() {
  const [layout, setLayout] = useState<LayoutResponse | null>(null);
  const [metrics, setMetrics] = useState<Map<string, NodeMetric> | null>(null);
  const [liveDraft, setLiveDraft] = useState<LayoutDraft | null>(null);
  const [draft, dispatch] = useReducer(draftReducer, EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const fetched = await api<LayoutResponse>(
          '/next-api/garage/cluster/layout'
        );
        if (cancelled) return;
        const seeded = draftFromLive(
          fetched.roles,
          fetched.replicationFactor,
          parseZoneRedundancy(fetched.parameters?.zoneRedundancy)
        );
        setLayout(fetched);
        setLiveDraft(seeded);
        dispatch({ type: 'reset', draft: seeded });
        setError(null);
        // Best-effort: Garage's own partition counts make the movement figure
        // a measurement rather than an estimate, but the planner works
        // without them.
        try {
          const latest = await fetchLatestNodeMetrics(
            pb,
            fetched.roles.map((r) => r.id)
          );
          if (!cancelled) setMetrics(latest);
        } catch {
          if (!cancelled) setMetrics(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load cluster layout'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  const liveRoles = useMemo(() => layout?.roles ?? [], [layout]);

  /** The layout exactly as it stands — the baseline, and the accuracy check. */
  const liveSimulation = useMemo<SimResult>(() => {
    if (!layout)
      return { ok: false, reason: 'not-enough-nodes', detail: EMPTY_DETAIL };
    return simulateLayout({
      nodes: liveRoles.map((role) => ({
        id: role.id,
        zone: role.zone,
        capacityBytes: role.capacity ?? null,
      })),
      replicationFactor: layout.replicationFactor,
      zoneRedundancy: parseZoneRedundancy(layout.parameters?.zoneRedundancy),
    });
  }, [layout, liveRoles]);

  const baseline = useMemo(
    () =>
      resolveBaseline({
        roles: liveRoles,
        metrics,
        layoutVersion: layout?.version ?? -1,
        replicationFactor: layout?.replicationFactor ?? 3,
        liveSimulation,
      }),
    [liveRoles, metrics, layout, liveSimulation]
  );

  const outcome = useMemo<
    { ok: true; result: SimResult } | { ok: false; message: string }
  >(() => {
    try {
      return {
        ok: true,
        result: simulateLayout({
          nodes: toSimNodes(draft),
          replicationFactor: draft.replicationFactor,
          zoneRedundancy: draft.zoneRedundancy,
          previous: baseline.partitions ?? undefined,
        }),
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }, [draft, baseline]);

  const diff = useMemo(() => diffDraft(liveRoles, draft), [liveRoles, draft]);
  const fieldErrors = useMemo(() => draftErrors(draft), [draft]);
  const result = outcome.ok ? outcome.result : null;
  const impact = useMemo(
    () =>
      result ? capacityImpact(liveSimulation, result, diff.newZones) : null,
    [liveSimulation, result, diff.newZones]
  );

  const staged = (layout?.stagedRoleChanges?.length ?? 0) > 0;
  const conformance: ConformanceState = useMemo(() => {
    if (staged) return { kind: 'staged' };
    if (!liveSimulation.ok || layout?.partitionSize === undefined) {
      return { kind: 'unknown' };
    }
    return liveSimulation.exact.partitionSizeBytes === layout.partitionSize
      ? { kind: 'match', partitionSizeBytes: layout.partitionSize }
      : {
          kind: 'mismatch',
          garageBytes: layout.partitionSize,
          simulatedBytes: liveSimulation.exact.partitionSizeBytes,
        };
  }, [staged, liveSimulation, layout]);

  const liveZones = useMemo(
    () => [...new Set(liveRoles.map((r) => r.zone))],
    [liveRoles]
  );

  return (
    <div className="space-y-6">
      <Alert>
        <Info />
        <AlertTitle>
          This is an approximation, and it changes nothing
        </AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{APPROXIMATION_DISCLAIMER}</p>
          <p>{NO_WRITE_NOTICE}</p>
        </AlertDescription>
      </Alert>

      {staged && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Staged layout changes are pending</AlertTitle>
          <AlertDescription>{STAGED_CHANGES_NOTICE}</AlertDescription>
        </Alert>
      )}

      {conformance.kind === 'mismatch' && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>
            This calculator disagrees with your cluster&rsquo;s current layout
          </AlertTitle>
          <AlertDescription>
            Garage reports a partition size of{' '}
            {formatCapacity(conformance.garageBytes)} for the layout as it
            stands; simulating that same layout here gives{' '}
            {formatCapacity(conformance.simulatedBytes)}. Treat every figure
            below as indicative only, and check against{' '}
            <code>garage layout show</code>.
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <p className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border p-3 text-sm">
          {error}
        </p>
      )}

      {loading && !layout ? (
        <p className="text-muted-foreground text-sm">Loading layout…</p>
      ) : layout ? (
        <>
          <PlannerNodeTable
            draft={draft}
            dispatch={dispatch}
            results={result?.ok ? result.estimated.nodes : null}
            liveZones={liveZones}
            dirty={diff.dirty}
            onReset={() =>
              liveDraft && dispatch({ type: 'reset', draft: liveDraft })
            }
          />

          {fieldErrors.length > 0 && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Some rows are incomplete</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {fieldErrors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
                <p>They are left out of the simulation below.</p>
              </AlertDescription>
            </Alert>
          )}

          {!outcome.ok && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>The simulation could not complete</AlertTitle>
              <AlertDescription>{outcome.message}</AlertDescription>
            </Alert>
          )}

          {result && !result.ok && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>This plan has no valid layout</AlertTitle>
              <AlertDescription>{failureMessage(result)}</AlertDescription>
            </Alert>
          )}

          {result?.ok && (
            <>
              <PlannerSummary
                result={result}
                baselineCapacityBytes={
                  liveSimulation.ok
                    ? liveSimulation.exact.effectiveCapacityBytes
                    : null
                }
                conformance={conformance}
                baselineSource={baseline.source}
              />

              {baseline.source !== 'garage' && (
                <p className="text-muted-foreground text-xs">
                  {baseline.source === 'simulated' ? (
                    <>
                      <ShieldCheck className="mr-1 inline h-3 w-3" />
                      Movement is measured against an <em>estimated</em>{' '}
                      baseline, because{' '}
                      {
                        BASELINE_REJECTION_COPY[
                          baseline.rejected ?? 'no-samples'
                        ]
                      }
                      .
                    </>
                  ) : (
                    <>
                      No movement figures:{' '}
                      {
                        BASELINE_REJECTION_COPY[
                          baseline.rejected ?? 'no-samples'
                        ]
                      }
                      .
                    </>
                  )}
                </p>
              )}

              {impact?.regression && impact.newZones.length > 0 && (
                <Alert variant="destructive">
                  <TriangleAlert />
                  <AlertTitle>
                    This plan reduces the cluster&rsquo;s capacity
                  </AlertTitle>
                  <AlertDescription>
                    Effective capacity would fall from{' '}
                    {formatCapacity(impact.beforeBytes ?? 0)} to{' '}
                    {impact.afterBytes === null
                      ? 'nothing — the plan has no valid layout'
                      : formatCapacity(impact.afterBytes)}
                    .{' '}
                    {impact.zoneRedundancyRaised
                      ? `Adding the zone ${impact.newZones.join(', ')} raised the
                         number of distinct zones every partition must reach, so
                         each zone is now capped at fewer replicas and the
                         smallest zone bounds the whole cluster.`
                      : `Check the new zone${impact.newZones.length === 1 ? '' : 's'} ${impact.newZones.join(', ')} — a zone name that
                         differs only in case or spelling from an existing one
                         creates a new zone rather than joining it.`}
                  </AlertDescription>
                </Alert>
              )}

              {result.warnings.map((warning) => (
                <Alert key={`${warning.kind}:${warning.subject}`}>
                  <TriangleAlert />
                  <AlertTitle>{warningTitle(warning)}</AlertTitle>
                  <AlertDescription>{warningBody(warning)}</AlertDescription>
                </Alert>
              ))}

              <PlannerZoneTable zones={result.estimated.zones} />
              <PlannerCommands commands={draftCommands(diff)} />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

/** Placeholder detail for the pre-fetch state, which renders no numbers. */
const EMPTY_DETAIL = {
  storageNodeCount: 0,
  storageZoneCount: 0,
  replicationFactor: 3,
  requestedZoneRedundancy: null,
};
