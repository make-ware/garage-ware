'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { NodeMetric } from '@garage-ware/shared';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { ClusterMap } from '@/components/cluster/cluster-map';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import pb from '@/lib/pocketbase';
import { fetchLatestNodeMetrics } from '@/lib/metrics/latest-node-metrics';
import type { ClusterNodesResponse } from '@/lib/types';

function ClusterLayoutPage() {
  const [data, setData] = useState<ClusterNodesResponse | null>(null);
  const [latestMetrics, setLatestMetrics] = useState<Map<
    string,
    NodeMetric
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
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
