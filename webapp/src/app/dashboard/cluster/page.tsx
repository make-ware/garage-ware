'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { NodeMetric } from '@garage-ware/shared';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { ClusterEventTimeline } from '@/components/cluster/cluster-event-timeline';
import { ClusterMap } from '@/components/cluster/cluster-map';
import { ClusterUnavailableNotice } from '@/components/cluster/cluster-unavailable';
import { CLUSTER_PANEL_CLASS } from '@/components/cluster/panel';
import { StorageCostCard } from '@/components/storage/storage-cost-card';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api-client';
import pb from '@/lib/pocketbase';
import { fetchLatestNodeMetrics } from '@/lib/metrics/latest-node-metrics';
import { parseNodeTags } from '@/lib/node-label';
import { clusterUsableBytes } from '@/lib/pricing/rates';
import { usePricingConfig } from '@/lib/pricing/use-pricing-config';
import { gibToBytes } from '@/lib/storage/units';
import type {
  ClusterNodesResponse,
  ClusterTimelineEvent,
  ClusterTimelineResponse,
  StorageSummary,
} from '@/lib/types';

function ClusterLayoutPage() {
  const { config: pricing } = usePricingConfig();
  const [data, setData] = useState<ClusterNodesResponse | null>(null);
  // The cost panel's own quota figure. Its own effect, and swallowing its own
  // failure, for the same reason the timeline has one: this page is the cluster
  // map, and a panel that could not price itself must not take the map down.
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [latestMetrics, setLatestMetrics] = useState<Map<
    string,
    NodeMetric
  > | null>(null);
  const [timeline, setTimeline] = useState<ClusterTimelineResponse | null>(
    null
  );
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Mutually exclusive with `error` by construction — the catch below sets one
  // or the other, never both.
  const [clusterUnavailable, setClusterUnavailable] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      // The timeline needs nothing from the layout, so it goes out now and is
      // awaited below — behind the map on the page, not behind it on the
      // wire. `.catch` is attached here rather than at the await so a fast
      // failure can't surface as an unhandled rejection.
      const timelinePromise = api<ClusterTimelineResponse>(
        '/next-api/garage/cluster/events'
      ).catch(() => null);
      try {
        const result = await api<ClusterNodesResponse>(
          '/next-api/garage/cluster/nodes'
        );
        if (cancelled) return;
        setData(result);
        setError(null);
        // The effect re-runs on `refreshKey`; a recovered cluster has to clear
        // the notice as well as the error.
        setClusterUnavailable(false);
        // Best-effort: the map is useful without samples, so a metrics
        // failure must not take the page down with it.
        try {
          const latest = await fetchLatestNodeMetrics(
            pb,
            result.items.map((i) => i.id)
          );
          if (!cancelled) setLatestMetrics(latest);
        } catch {
          if (!cancelled) setLatestMetrics(null);
        }
      } catch (err) {
        if (!cancelled) {
          // This page is redacted for every signed-in user, but the two bodies
          // `garageErrorResponse` writes for an unreachable/unauthenticated
          // cluster (lib/auth/server.ts:200 and :218) are addressed to an
          // administrator and name GARAGE_ADMIN_URL / GARAGE_ADMIN_TOKEN.
          // Suppress them behind the gentle notice.
          //
          // Discriminating on HTTP status rather than the error `code`:
          // ApiError parses `code` off the body and drops it, and status fails
          // *safe* — an unrecognised cluster failure lands in the redacted
          // branch, where code-based matching would fall through to the raw
          // message. 502 is included because that is where the token message
          // lives.
          const unavailable =
            err instanceof ApiError &&
            (err.status === 503 || err.status === 502);
          setClusterUnavailable(unavailable);
          setError(
            unavailable
              ? null
              : err instanceof Error
                ? err.message
                : 'Failed to load cluster layout'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
      // Enrichment, like the samples above: the map is the page, and a
      // timeline that failed costs only the timeline.
      const events = await timelinePromise;
      if (!cancelled) {
        setTimeline(events);
        setTimelineError(events ? null : 'Timeline unavailable');
        setTimelineLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    const loadSummary = async () => {
      try {
        const result = await api<StorageSummary>(
          '/next-api/garage/storage-summary'
        );
        if (!cancelled) setSummary(result);
      } catch {
        if (!cancelled) setSummary(null);
      }
    };
    loadSummary();
    return () => {
      cancelled = true;
    };
  }, []);

  const zoneCount = useMemo(
    () => new Set((data?.items ?? []).map((i) => i.zone)).size,
    [data]
  );

  // Open rows, keyed by the node they pin to, whatever wrote them.
  // Cluster-wide rows carry an empty node_id and are skipped — these are
  // per-node states. ClusterMap splits them by source.
  const openEventsByNode = useMemo(() => {
    const map = new Map<string, ClusterTimelineEvent[]>();
    for (const event of timeline?.openEvents ?? []) {
      if (!event.node_id) continue;
      const list = map.get(event.node_id);
      if (list) list.push(event);
      else map.set(event.node_id, [event]);
    }
    return map;
  }, [timeline]);

  // Names come from the layout the page already holds — an event row stores
  // only a node id, and `node_hostname` is explicitly not the label.
  const nodeNames = useMemo(
    () =>
      new Map(
        (data?.items ?? []).map((i) => [i.id, parseNodeTags(i.tags).name])
      ),
    [data]
  );

  return (
    <div className="container mx-auto max-w-6xl space-y-6 px-4 py-8">
      <Link
        href="/dashboard"
        className="text-sm text-muted-foreground hover:underline inline-flex items-center"
      >
        <ArrowLeft className="mr-1 h-4 w-4" /> Back to dashboard
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Cluster layout</h1>
          <p className="text-sm text-muted-foreground">
            {data
              ? `${data.items.length} node${data.items.length === 1 ? '' : 's'} across ` +
                `${zoneCount} zone${zoneCount === 1 ? '' : 's'} · ` +
                `replication factor ${data.replicationFactor} · layout v${data.layoutVersion}`
              : 'Nodes grouped by zone — click a node for details.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            Refresh
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <Link href="/dashboard/metrics">View metrics</Link>
          </Button>
        </div>
      </div>

      <StorageCostCard
        className={CLUSTER_PANEL_CLASS}
        quotaBytes={summary ? gibToBytes(summary.netGrantedGb) : 0}
        clusterUsableBytes={
          data ? clusterUsableBytes(data.items, data.replicationFactor) : 0
        }
        replicationFactor={data?.replicationFactor ?? 1}
        pricing={pricing}
        loading={loading}
      />

      {clusterUnavailable && <ClusterUnavailableNotice />}

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data ? (
        <ClusterMap
          items={data.items}
          replicationFactor={data.replicationFactor}
          latestMetrics={latestMetrics}
          openEventsByNode={openEventsByNode}
        />
      ) : null}

      <ClusterEventTimeline
        events={timeline?.items ?? null}
        nodeNames={nodeNames}
        loading={timelineLoading}
        error={timelineError}
        totalItems={timeline?.totalItems ?? 0}
      />
    </div>
  );
}

export default function ClusterPage() {
  return (
    <ProtectedRoute>
      <ClusterLayoutPage />
    </ProtectedRoute>
  );
}
