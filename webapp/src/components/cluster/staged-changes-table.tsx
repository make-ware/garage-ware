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
import {
  describeStagedChanges,
  type StagedChangeRow,
  type StagedRoleChangeLike,
  type StagingRole,
} from '@/lib/cluster/staged-changes';
import {
  EMPTY_STAGED_COPY,
  UNRECOGNISED_CHANGE_COPY,
} from '@/lib/cluster/staging-copy';

/**
 * What is waiting for `garage layout apply`, as a before → after.
 *
 * Styled after `garage layout show` like the planner's tables, and driven
 * entirely by `describeStagedChanges` so the join between a staged change and
 * the role it replaces is testable without rendering anything.
 *
 * The `unrecognised` row is the one worth keeping. `apply` commits every staged
 * change, including shapes this version cannot read, so one has to appear here
 * as "something is staged on this node" rather than silently not appear at all.
 */
export function StagedChangesTable({
  roles,
  staged,
}: {
  roles: readonly StagingRole[];
  staged: readonly StagedRoleChangeLike[];
}) {
  const rows = describeStagedChanges(roles, staged);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Staged changes</CardTitle>
        <CardDescription>
          Pending in Garage, not applied. Confirm with{' '}
          <code>garage layout show</code> before applying — that output, not
          this page, is what Garage will do.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{EMPTY_STAGED_COPY}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Node</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.nodeKey}:${row.kind}`}>
                  <TableCell>
                    <NodeIdentity name={row.name} nodeId={row.nodeKey}>
                      {row.isNew && (
                        <span className="text-muted-foreground ml-2 text-xs">
                          (no role yet)
                        </span>
                      )}
                    </NodeIdentity>
                  </TableCell>
                  <TableCell>
                    <ChangeBadge kind={row.kind} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {describeSide(
                      row.fromZone,
                      row.fromCapacityBytes,
                      row.fromTags
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.kind === 'remove' ? (
                      <span>Removed from the layout</span>
                    ) : row.kind === 'unrecognised' ? (
                      <span className="text-amber-600">
                        {UNRECOGNISED_CHANGE_COPY}
                      </span>
                    ) : (
                      describeSide(row.toZone, row.toCapacityBytes, row.toTags)
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ChangeBadge({ kind }: { kind: StagedChangeRow['kind'] }) {
  if (kind === 'remove') {
    return <Badge variant="outline">Remove</Badge>;
  }
  if (kind === 'unrecognised') {
    return (
      <Badge variant="outline" className="text-amber-600">
        Unrecognised
      </Badge>
    );
  }
  return <Badge variant="outline">Assign</Badge>;
}

/**
 * One side of the diff. A `null` capacity on a role that exists is a
 * **gateway** — Garage's own encoding — and saying "gateway" rather than "—" is
 * the difference between "stores nothing by design" and "we do not know".
 */
function describeSide(
  zone: string | null,
  capacityBytes: number | null,
  tags: readonly string[]
): React.ReactNode {
  if (zone === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span>
      {zone} ·{' '}
      {capacityBytes === null ? 'gateway' : formatCapacity(capacityBytes)}
      {tags.length > 0 && (
        <span className="text-muted-foreground"> · {tags.join(', ')}</span>
      )}
    </span>
  );
}
