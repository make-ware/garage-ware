'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CLUSTER_PANEL_CLASS } from '@/components/cluster/panel';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import type { LayoutHistoryPayload } from '@/lib/admin-types';

/**
 * Past layout versions, as Garage remembers them: counts, and nothing else.
 *
 * **There are no timestamps in this API** — a version row says how many storage
 * and gateway nodes it had and gives no hint when it happened or who caused it.
 * That absence is the whole reason `ClusterEvents` exists, so the card says so
 * and points at `/admin/events` rather than implying a chronology it does not
 * have.
 *
 * Best-effort: a failure degrades to one muted line. This is context beside the
 * staging controls, and it must never be the thing that stops an operator
 * staging a change.
 */
export function LayoutHistoryCard() {
  const [history, setHistory] = useState<LayoutHistoryPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const fetched = await api<LayoutHistoryPayload>(
          '/next-api/garage/cluster/layout-history'
        );
        if (!cancelled) setHistory(fetched);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return (
      <p className="text-muted-foreground text-xs">
        Layout history is unavailable.
      </p>
    );
  }
  if (!history) return null;

  return (
    <Card className={cn(CLUSTER_PANEL_CLASS)}>
      <CardHeader>
        <CardTitle className="text-base">Layout history</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Storage nodes</TableHead>
              <TableHead className="text-right">Gateway nodes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.versions.map((version) => (
              <TableRow key={version.version}>
                <TableCell className="tabular-nums">
                  {version.version}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{version.status}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {version.storageNodes}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {version.gatewayNodes}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-muted-foreground text-xs">
          All nodes have acknowledged version {history.minAck}. Garage records
          no timestamps for layout versions — for when a change happened and who
          made it, see <Link href="/admin/events">the cluster timeline</Link>.
        </p>
      </CardContent>
    </Card>
  );
}
