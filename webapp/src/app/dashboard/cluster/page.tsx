'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { NodeMetric } from '@garage-ware/shared';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { ClusterEventTimeline } from '@/components/cluster/cluster-event-timeline';
import { ClusterMap } from '@/components/cluster/cluster-map';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import pb from '@/lib/pocketbase';
import { fetchLatestNodeMetrics } from '@/lib/metrics/latest-node-metrics';
import { parseNodeTags } from '@/lib/node-label';
import type {
  ClusterNodesResponse,
  ClusterTimelineResponse,
} from '@/lib/types';

function ClusterLayoutPage() {
  const [data, setData] = useState<ClusterNodesResponse | null>(null);
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
          setError(
            err instanceof Error ? err.message : 'Failed to load cluster layout'
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

  const zoneCount = useMemo(
    () => new Set((data?.items ?? []).map((i) => i.zone)).size,
    [data]
  );

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
