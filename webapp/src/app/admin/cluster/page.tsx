'use client';

import { useEffect, useMemo, useState } from 'react';
import type { NodeMetric } from '@garage-ware/shared';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ClusterMap } from '@/components/cluster/cluster-map';
import { api } from '@/lib/api-client';
import pb from '@/lib/pocketbase';
import { fetchLatestNodeMetrics } from '@/lib/metrics/latest-node-metrics';
import { cn } from '@/lib/utils';
import type { ClusterHealth, ClusterStatus } from '@/lib/garage';
import type { ClusterNodesResponse } from '@/lib/types';

function StatCard({
  title,
  value,
  detail,
  tone,
}: {
  title: string;
  value: string;
  detail?: string;
  tone?: 'ok' | 'warn' | 'bad';
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle
          className={cn(
            'text-2xl',
            tone === 'ok' && 'text-emerald-500',
            tone === 'warn' && 'text-amber-500',
            tone === 'bad' && 'text-destructive'
          )}
        >
          {value}
        </CardTitle>
        {detail && (
          <CardDescription className="text-xs">{detail}</CardDescription>
        )}
      </CardHeader>
    </Card>
  );
}

export default function ClusterDetailPage() {
  const [health, setHealth] = useState<ClusterHealth | null>(null);
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [nodes, setNodes] = useState<ClusterNodesResponse | null>(null);
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
        // Status is fetched only for `addr` — the shared /cluster/nodes
        // payload deliberately never carries node addresses.
        const [h, s, n] = await Promise.all([
          api<ClusterHealth>('/next-api/garage/cluster/health'),
          api<ClusterStatus>('/next-api/garage/cluster/status'),
          api<ClusterNodesResponse>('/next-api/garage/cluster/nodes'),
        ]);
        if (cancelled) return;
        setHealth(h);
        setStatus(s);
        setNodes(n);
        setError(null);
        try {
          const latest = await fetchLatestNodeMetrics(
            pb,
            n.items.map((i) => i.id)
          );
          if (!cancelled) setLatestMetrics(latest);
        } catch {
          if (!cancelled) setLatestMetrics(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load cluster state'
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

  const addrByNodeId = useMemo(
    () =>
      status
        ? new Map(status.nodes.map((n) => [n.id, n.addr ?? null]))
        : undefined,
    [status]
  );

  return (
    <div className="p-8 max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Cluster</h1>
          {nodes && (
            <p className="text-sm text-muted-foreground">
              Layout v{nodes.layoutVersion} · replication factor{' '}
              {nodes.replicationFactor}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRefreshKey((k) => k + 1)}
        >
          Refresh
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {health && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Health"
            value={health.status}
            tone={
              health.status === 'healthy'
                ? 'ok'
                : health.status === 'degraded'
                  ? 'warn'
                  : 'bad'
            }
          />
          <StatCard
            title="Nodes connected"
            value={`${health.connectedNodes} / ${health.knownNodes}`}
            tone={
              health.connectedNodes < health.knownNodes ? 'warn' : undefined
            }
          />
          <StatCard
            title="Storage nodes up"
            value={`${health.storageNodesUp} / ${health.storageNodes}`}
            tone={
              health.storageNodesUp < health.storageNodes ? 'bad' : undefined
            }
          />
          <StatCard
            title="Partitions healthy"
            value={`${health.partitionsAllOk} / ${health.partitions}`}
            detail={`${health.partitionsQuorum} with quorum`}
            tone={
              health.partitionsQuorum < health.partitions
                ? 'bad'
                : health.partitionsAllOk < health.partitions
                  ? 'warn'
                  : undefined
            }
          />
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : nodes ? (
        <ClusterMap
          items={nodes.items}
          replicationFactor={nodes.replicationFactor}
          latestMetrics={latestMetrics}
          addrByNodeId={addrByNodeId}
        />
      ) : null}
    </div>
  );
}
