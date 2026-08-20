'use client';

import { Badge } from '@/components/ui/badge';
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
import { formatCapacity } from '@/lib/format';
import { PARTITION_COUNT, type SimZoneResult } from '@/lib/cluster/layout-sim';

/**
 * Per-zone totals — and the one thing `garage layout show` does not tell you:
 * *why* the partition size is what it is.
 *
 * `Replicas / partition` is `min(nodes in zone, rf − k + 1)`: how many copies
 * of any single partition this zone is allowed to hold. Multiplied by 256 it
 * gives the zone's ceiling, and a zone sitting on its ceiling with capacity to
 * spare is the Example-1 shape. `Limiting` is the direct answer to "which zone
 * do I have to grow" — it is true when unbinding *this zone alone* would raise
 * the partition size, so no zone marked means more than one has to grow.
 */
export function PlannerZoneTable({
  zones,
}: {
  zones: readonly SimZoneResult[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Zones</CardTitle>
        <CardDescription>
          A zone can never hold more than {PARTITION_COUNT} × its replicas per
          partition. That ceiling, not the disks, is usually what bounds a
          cluster.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Zone</TableHead>
              <TableHead className="text-right">Nodes</TableHead>
              <TableHead className="text-right">Replicas / partition</TableHead>
              <TableHead className="text-right">Partitions</TableHead>
              <TableHead className="text-right">Declared</TableHead>
              <TableHead className="text-right">Usable</TableHead>
              <TableHead className="text-right">Usable %</TableHead>
              <TableHead>Constraint</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {zones.map((zone) => (
              <TableRow key={zone.zone}>
                <TableCell className="font-medium">{zone.zone}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {zone.storageNodeCount}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {zone.replicasPerPartition}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {zone.estimatedPartitions}
                  <span className="text-muted-foreground">
                    {' '}
                    / {zone.maxPartitions}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCapacity(zone.declaredCapacityBytes)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCapacity(zone.estimatedUsableBytes)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {zone.estimatedUsablePct === null
                    ? '—'
                    : `${zone.estimatedUsablePct.toFixed(1)}%`}
                </TableCell>
                <TableCell>
                  {zone.limiting ? (
                    <Badge variant="outline" className="text-amber-600">
                      Limiting
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
