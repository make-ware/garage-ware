'use client';

import { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api-client';
import { formatBytes } from '@/lib/format';
import { nodeLabel, parseNodeTags, shortNodeId } from '@/lib/node-label';
import type { ClusterHealth, ClusterStatus } from '@/lib/garage';
import type { LayoutResponse } from '@/lib/admin-types';

export default function AdminOverviewPage() {
  const [health, setHealth] = useState<ClusterHealth | null>(null);
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [layout, setLayout] = useState<LayoutResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<ClusterHealth>('/next-api/garage/cluster/health'),
      api<ClusterStatus>('/next-api/garage/cluster/status'),
      api<LayoutResponse>('/next-api/garage/cluster/layout'),
    ])
      .then(([h, s, l]) => {
        setHealth(h);
        setStatus(s);
        setLayout(l);
      })
      .catch((err) => setError(err.message));
  }, []);

  const totalCapacityBytes = layout?.roles.reduce(
    (sum, r) => sum + (r.capacity ?? 0),
    0
  );
  const usableBytes =
    totalCapacityBytes !== undefined && layout
      ? Math.floor(totalCapacityBytes / Math.max(layout.replicationFactor, 1))
      : undefined;

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-3xl font-bold mb-6">Cluster overview</h1>

      {error && (
        <Card className="mb-6 border-destructive">
          <CardContent className="pt-6 text-destructive text-sm">
            {error}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Health</CardDescription>
            <CardTitle className="flex items-center gap-2">
              {health ? (
                <Badge
                  variant={
                    health.status === 'healthy' ? 'default' : 'destructive'
                  }
                >
                  {health.status}
                </Badge>
              ) : (
                'Loading...'
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {health
              ? `${health.connectedNodes}/${health.knownNodes} nodes connected, ${health.partitionsAllOk}/${health.partitions} partitions fully ok`
              : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Replication factor</CardDescription>
            <CardTitle>{layout?.replicationFactor ?? '—'}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Layout version {layout?.version ?? '—'}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Usable capacity</CardDescription>
            <CardTitle>
              {usableBytes !== undefined ? formatBytes(usableBytes) : '—'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {totalCapacityBytes !== undefined
              ? `${formatBytes(totalCapacityBytes)} raw`
              : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Nodes</CardTitle>
          <CardDescription>
            Live cluster status. For metric history see your Grafana dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status ? (
            <div className="space-y-2">
              {status.nodes.map((n) => {
                // A node absent from the layout has no role, so no tags and no
                // name — it falls back to its short id, which is correct.
                const { name } = parseNodeTags(n.role?.tags);
                return (
                  <div
                    key={n.id}
                    className="flex items-center justify-between rounded border p-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {nodeLabel(name, n.id)}
                      </div>
                      <div className="truncate text-xs text-muted-foreground font-mono">
                        {/* The short id joins this line only when the line above
                          is a name — otherwise it would appear twice. */}
                        {name ? `${shortNodeId(n.id)} · ` : ''}
                        {n.addr ?? '—'} · {n.role?.zone ?? 'no zone'}
                      </div>
                    </div>
                    <Badge variant={n.isUp ? 'default' : 'destructive'}>
                      {n.isUp ? 'up' : 'down'}
                    </Badge>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-muted-foreground">Loading...</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
