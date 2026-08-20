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
import { NodeIdentity } from '@/components/cluster/node-identity';
import { formatCapacity } from '@/lib/format';
import { parseNodeTags } from '@/lib/node-label';
import type { StagingRole } from '@/lib/cluster/staged-changes';

/**
 * The layout as it stands, styled after `garage layout show`.
 *
 * Tags go through `parseNodeTags`, so a node's `name:` tag is consumed once —
 * as the name in the first column — and never rendered twice.
 *
 * The layout version is in the header rather than a corner of the page: it is
 * the number `garage layout apply --version` is derived from, and the one an
 * operator has to recognise when a conflict tells them it has moved.
 */
export function StagingCurrentTable({
  roles,
  version,
}: {
  roles: readonly StagingRole[];
  version: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Current layout — version {version}</CardTitle>
        <CardDescription>
          What the cluster is running now. Staged changes, if any, are listed
          separately below.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {roles.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No node has a role in this layout yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Node</TableHead>
                <TableHead>Zone</TableHead>
                <TableHead className="text-right">Capacity</TableHead>
                <TableHead>Tags</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((role) => {
                const { name, rest } = parseNodeTags(role.tags);
                const gateway =
                  role.capacity === null || role.capacity === undefined;
                return (
                  <TableRow key={role.id}>
                    <TableCell>
                      <NodeIdentity name={name} nodeId={role.id} />
                    </TableCell>
                    <TableCell>{role.zone}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {gateway ? (
                        <Badge variant="outline">Gateway</Badge>
                      ) : (
                        formatCapacity(role.capacity as number)
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {rest.length > 0 ? rest.join(', ') : '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
