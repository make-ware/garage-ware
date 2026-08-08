'use client';

import { useEffect, useState } from 'react';
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
import { api } from '@/lib/api-client';
import { formatStorage } from '@/lib/format';
import { bytesToGib } from '@/lib/storage/units';
import type { ClusterHealth, ClusterStatus } from '@/lib/garage';
import type { LayoutResponse } from '@/lib/admin-types';

export default function ClusterDetailPage() {
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

  return (
    <div className="p-8 max-w-6xl">
      <h1 className="text-3xl font-bold mb-6">Cluster</h1>
      {error && <p className="text-destructive mb-4">{error}</p>}

      {health && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Health</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs bg-muted p-4 rounded overflow-x-auto">
              {JSON.stringify(health, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

      {layout && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Layout (v{layout.version})</CardTitle>
            <CardDescription>
              Replication factor: <strong>{layout.replicationFactor}</strong>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Node</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead>Capacity</TableHead>
                  <TableHead>Tags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {layout.roles.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">
                      {r.id.slice(0, 16)}…
                    </TableCell>
                    <TableCell>{r.zone}</TableCell>
                    <TableCell>
                      {r.capacity ? formatStorage(bytesToGib(r.capacity)) : '—'}
                    </TableCell>
                    <TableCell>{r.tags?.join(', ') || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {status && (
        <Card>
          <CardHeader>
            <CardTitle>Nodes</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Hostname</TableHead>
                  <TableHead>Addr</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {status.nodes.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell>{n.hostname || n.id.slice(0, 12)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {n.addr ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={n.isUp ? 'default' : 'destructive'}>
                        {n.isUp ? 'up' : 'down'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {n.lastSeenSecsAgo !== null &&
                      n.lastSeenSecsAgo !== undefined
                        ? `${n.lastSeenSecsAgo}s ago`
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
