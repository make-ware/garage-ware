'use client';

import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
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
  draftNodeError,
  type CapacityUnit,
  type DraftAction,
  type DraftNode,
  type LayoutDraft,
} from '@/lib/cluster/layout-draft';
import type { SimNodeResult } from '@/lib/cluster/layout-sim';

/**
 * The plan itself: one editable row per node, with what the simulation makes of
 * that row on the same line.
 *
 * Editing and outcome share a row rather than sitting in two tables because the
 * question this page answers is "what happens if I change *this*" — and the
 * documented surprise (a node that would store 0 B) is only startling when it
 * appears beside the capacity you just typed.
 *
 * **Capacity is a plain SI input**, not `<StorageQuotaInput>`: that control
 * speaks binary GiB because the storage ledger does, and Garage's layout
 * capacities are decimal. Mixing the two here would misstate every node by 7%.
 *
 * The zone field suggests the zones that already exist and flags one that does
 * not. Introducing a zone is the single edit that can *reduce* capacity while
 * reading as an addition — under `maximum` redundancy it raises the effective
 * `k` — and `dc1` typed as `DC1` does exactly that.
 */
interface PlannerNodeTableProps {
  draft: LayoutDraft;
  dispatch: React.Dispatch<DraftAction>;
  /** Per-node outcome, or `null` when the plan has no feasible layout. */
  results: readonly SimNodeResult[] | null;
  /** Zones present in the live layout — anything else is a new zone. */
  liveZones: readonly string[];
  onReset: () => void;
  dirty: boolean;
}

export function PlannerNodeTable({
  draft,
  dispatch,
  results,
  liveZones,
  onReset,
  dirty,
}: PlannerNodeTableProps) {
  const resultById = new Map(results?.map((r) => [r.id, r]) ?? []);
  const zoneOptions = [
    ...new Set([...liveZones, ...draft.nodes.map((n) => n.zone.trim())]),
  ]
    .filter(Boolean)
    .sort();
  const maxRedundancy = draft.replicationFactor;
  // At least 1-3, but extended to cover a live cluster whose replication
  // factor is already higher — otherwise loading such a cluster leaves no
  // button selected and no way back to its actual value.
  const replicationFactorOptions = Array.from(
    { length: Math.max(3, draft.replicationFactor) },
    (_, i) => i + 1
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Planned nodes</CardTitle>
        <CardDescription>
          Prefilled from the current layout. Edit a capacity, move a node
          between zones, add a node that does not exist yet — nothing here is
          sent anywhere.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-6">
          <div className="space-y-1.5">
            <Label className="text-xs">Replication factor</Label>
            <div className="flex gap-1">
              {replicationFactorOptions.map((rf) => (
                <Button
                  key={rf}
                  size="sm"
                  variant={
                    draft.replicationFactor === rf ? 'secondary' : 'outline'
                  }
                  onClick={() =>
                    dispatch({ type: 'set-replication-factor', value: rf })
                  }
                >
                  {rf}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Zone redundancy</Label>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={
                  draft.zoneRedundancy.mode === 'maximum'
                    ? 'secondary'
                    : 'outline'
                }
                onClick={() =>
                  dispatch({
                    type: 'set-zone-redundancy',
                    value: { mode: 'maximum' },
                  })
                }
              >
                Maximum
              </Button>
              {Array.from({ length: maxRedundancy }, (_, i) => i + 1).map(
                (n) => (
                  <Button
                    key={n}
                    size="sm"
                    variant={
                      draft.zoneRedundancy.mode === 'atLeast' &&
                      draft.zoneRedundancy.atLeast === n
                        ? 'secondary'
                        : 'outline'
                    }
                    onClick={() =>
                      dispatch({
                        type: 'set-zone-redundancy',
                        value: { mode: 'atLeast', atLeast: n },
                      })
                    }
                  >
                    ≥ {n}
                  </Button>
                )
              )}
            </div>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Node</TableHead>
              <TableHead>Zone</TableHead>
              <TableHead>Capacity</TableHead>
              <TableHead className="text-center">Gateway</TableHead>
              <TableHead className="text-right">Partitions</TableHead>
              <TableHead className="text-right">Usable</TableHead>
              <TableHead className="text-right">Usable %</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {draft.nodes.map((node) => (
              <PlannerRow
                key={node.key}
                node={node}
                result={resultById.get(node.key) ?? null}
                zoneOptions={zoneOptions}
                isNewZone={
                  node.zone.trim() !== '' &&
                  !liveZones.includes(node.zone.trim())
                }
                dispatch={dispatch}
              />
            ))}
          </TableBody>
        </Table>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => dispatch({ type: 'add-node' })}
          >
            <Plus />
            Add node
          </Button>
          <Button size="sm" variant="ghost" onClick={onReset} disabled={!dirty}>
            <RotateCcw />
            Reset to current layout
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PlannerRow({
  node,
  result,
  zoneOptions,
  isNewZone,
  dispatch,
}: {
  node: DraftNode;
  result: SimNodeResult | null;
  zoneOptions: readonly string[];
  isNewZone: boolean;
  dispatch: React.Dispatch<DraftAction>;
}) {
  const error = draftNodeError(node);
  const listId = `planner-zones-${node.key}`;

  return (
    <TableRow>
      <TableCell>
        {node.nodeId ? (
          <NodeIdentity name={node.name} nodeId={node.nodeId} />
        ) : (
          <span className="text-muted-foreground text-sm italic">New node</span>
        )}
      </TableCell>
      <TableCell>
        <Input
          aria-label={`Zone for ${node.name ?? node.key}`}
          value={node.zone}
          list={listId}
          className="h-8 w-28"
          onChange={(e) =>
            dispatch({
              type: 'edit-zone',
              key: node.key,
              zone: e.target.value,
            })
          }
        />
        <datalist id={listId}>
          {zoneOptions.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        {isNewZone && (
          <Badge variant="outline" className="mt-1 text-amber-600">
            New zone
          </Badge>
        )}
      </TableCell>
      <TableCell>
        {node.gateway ? (
          <span className="text-muted-foreground text-sm">—</span>
        ) : (
          <div className="flex items-center gap-1">
            <Input
              aria-label={`Capacity for ${node.name ?? node.key}`}
              value={node.capacityValue}
              inputMode="decimal"
              className="h-8 w-20"
              onChange={(e) =>
                dispatch({
                  type: 'edit-capacity',
                  key: node.key,
                  value: e.target.value,
                })
              }
            />
            <Select
              value={node.capacityUnit}
              onValueChange={(unit) =>
                dispatch({
                  type: 'edit-unit',
                  key: node.key,
                  unit: unit as CapacityUnit,
                })
              }
            >
              <SelectTrigger
                size="sm"
                aria-label={`Capacity unit for ${node.name ?? node.key}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="GB">GB</SelectItem>
                <SelectItem value="TB">TB</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {error && <p className="text-destructive mt-1 text-xs">{error}</p>}
      </TableCell>
      <TableCell className="text-center">
        <Switch
          aria-label={`Gateway for ${node.name ?? node.key}`}
          checked={node.gateway}
          onCheckedChange={() =>
            dispatch({ type: 'toggle-gateway', key: node.key })
          }
        />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {result ? (
          <span className="inline-flex items-center gap-1.5">
            {result.estimatedPartitions}
            <DeltaBadge delta={result.partitionDelta} />
          </span>
        ) : (
          '—'
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {result ? formatCapacity(result.estimatedUsableBytes) : '—'}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {result?.estimatedUsablePct === null || !result
          ? '—'
          : `${result.estimatedUsablePct.toFixed(1)}%`}
      </TableCell>
      <TableCell>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Remove ${node.name ?? node.key}`}
          onClick={() => dispatch({ type: 'remove-node', key: node.key })}
        >
          <Trash2 />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null || delta === 0) return null;
  return (
    <Badge
      variant="outline"
      className={delta > 0 ? 'text-emerald-600' : 'text-amber-600'}
    >
      {delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`}
    </Badge>
  );
}
