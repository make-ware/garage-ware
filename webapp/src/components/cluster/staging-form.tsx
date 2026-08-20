'use client';

import { useMemo, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
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
import { nodeLabel } from '@/lib/node-label';
import {
  CAPACITY_UNIT_BYTES,
  draftNodeError,
  nodeCapacityBytes,
  splitCapacity,
  type CapacityUnit,
  type DraftNode,
} from '@/lib/cluster/layout-draft';
import type {
  StageChangeRequest,
  StagingCandidate,
  StagingRolePayload,
} from '@/lib/admin-types';
import type { StagedRoleChangeLike } from '@/lib/cluster/staged-changes';

/**
 * Stage one node's role — or mark it for removal.
 *
 * **Every field is submitted every time, and prefilling is what makes that
 * safe.** `UpdateClusterLayout` is documented as requiring `zone`, `capacity`
 * and `tags` together — "contrary to the CLI … when calling this API all of
 * these values must be specified" — so a form that let an operator edit the
 * zone alone would write the node's tags away, including the `name:` tag the
 * whole app labels it by. The fields therefore start from **what is already
 * staged for that node, else its live role, else blank**, in that order: a
 * second edit before applying has to build on the first, not on a layout the
 * cluster is no longer going to have.
 *
 * Capacity is a plain SI input with a GB/TB unit, not `<StorageQuotaInput>`:
 * that control speaks binary GiB because the storage ledger does, and Garage's
 * layout capacities are decimal. Mixing them would misstate every node by 7%.
 * The row is validated through the planner's own `draftNodeError`, so "0 means
 * you wanted the gateway switch" is one rule with one wording.
 *
 * Removal goes through the type-the-node-name challenge — the `/admin/repairs`
 * precedent, non-destructive variant — because a removal is the one change here
 * whose before → after diff cannot reassure you that you picked the right node.
 */
interface StagingFormProps {
  candidates: readonly StagingCandidate[];
  roles: readonly StagingRolePayload[];
  staged: readonly StagedRoleChangeLike[];
  submitting: boolean;
  onStage: (change: StageChangeRequest) => Promise<void>;
}

/** Every editable field, as one value — so "what has the operator changed" is one comparison. */
interface StagingFields {
  zone: string;
  gateway: boolean;
  capacityValue: string;
  capacityUnit: CapacityUnit;
  tagsText: string;
}

/**
 * What the form starts from for a node: **what is already staged for it, else
 * its live role, else blank** — in that order.
 *
 * The order is the load-bearing part. A second edit before applying has to
 * build on the first: the API writes all three of zone, capacity and tags
 * together, so prefilling from the live role after something is already staged
 * would quietly revert whichever field the operator did not touch this time.
 *
 * Derived during render rather than pushed into state by an effect — it is a
 * function of the payload and the selected node, and `react-hooks/set-state-in-effect`
 * is right that state synchronised from props is not state.
 */
function prefillFor(
  nodeId: string,
  staged: readonly StagedRoleChangeLike[],
  roles: readonly StagingRolePayload[],
  candidate: StagingCandidate | null
): StagingFields {
  const stagedForNode = staged.find(
    (change) => change.id === nodeId && change.remove !== true
  );
  const role = roles.find((r) => r.id === nodeId);
  const source =
    stagedForNode && typeof stagedForNode.zone === 'string'
      ? {
          zone: stagedForNode.zone,
          capacity: stagedForNode.capacity ?? null,
          tags: [...(stagedForNode.tags ?? [])],
        }
      : role
        ? { zone: role.zone, capacity: role.capacity, tags: role.tags }
        : null;

  if (!source) {
    // A node with no role yet: its zone, if Garage reports one, and nothing
    // invented for the capacity — a guessed number here would be staged as
    // fact.
    return {
      zone: candidate?.zone ?? '',
      gateway: false,
      capacityValue: '',
      capacityUnit: 'TB',
      tagsText: '',
    };
  }

  const split =
    source.capacity === null ? null : splitCapacity(source.capacity);
  return {
    zone: source.zone,
    gateway: source.capacity === null,
    capacityValue: split?.value ?? '',
    capacityUnit: split?.unit ?? 'TB',
    tagsText: source.tags.join(', '),
  };
}

export function StagingForm({
  candidates,
  roles,
  staged,
  submitting,
  onStage,
}: StagingFormProps) {
  const [nodeId, setNodeId] = useState(candidates[0]?.id ?? '');
  /** Only the fields the operator has actually touched for this node. */
  const [edits, setEdits] = useState<Partial<StagingFields>>({});

  const selected = candidates.find((c) => c.id === nodeId) ?? null;
  const prefill = useMemo(
    () => prefillFor(nodeId, staged, roles, selected),
    [nodeId, staged, roles, selected]
  );

  const fields: StagingFields = { ...prefill, ...edits };
  const { zone, gateway, capacityValue, capacityUnit, tagsText } = fields;
  const edit = (change: Partial<StagingFields>) =>
    setEdits((current) => ({ ...current, ...change }));

  // Switching node discards the edits with it — they described a different
  // node, and carrying a capacity across would be the worst kind of prefill.
  const chooseNode = (next: string) => {
    setNodeId(next);
    setEdits({});
  };

  const tags = tagsText
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  /** The row as the planner's validator sees it — one rule, one wording. */
  const draft: DraftNode = {
    key: nodeId,
    nodeId,
    name: selected?.name ?? null,
    zone,
    gateway,
    capacityValue,
    capacityUnit,
  };

  const fieldError = nodeId
    ? draftNodeError(draft)
    : 'Choose a node to stage a change for';
  const tagError = tags.some((tag) => /[\s,]/.test(tag))
    ? 'A tag cannot contain spaces or commas'
    : null;
  const error = fieldError ?? tagError;

  const liveZones = useMemo(
    () => [...new Set(roles.map((r) => r.zone))].sort(),
    [roles]
  );
  const isNewZone = zone.trim().length > 0 && !liveZones.includes(zone.trim());

  const label = selected
    ? nodeLabel(selected.name, selected.id)
    : (nodeId ?? '');

  const stageAssign = async () => {
    if (error) return;
    await onStage({
      action: 'assign',
      nodeId,
      zone: zone.trim(),
      gateway,
      capacityBytes: gateway ? null : nodeCapacityBytes(draft),
      tags,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stage a change</CardTitle>
        <CardDescription>
          Prefilled from what is already staged for this node, or from its
          current role. All three of zone, capacity and tags are written
          together — that is what the Garage API requires, so leaving a field
          alone still submits its value.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="staging-node" className="text-xs">
              Node
            </Label>
            <Select value={nodeId} onValueChange={chooseNode}>
              <SelectTrigger id="staging-node" className="w-64">
                <SelectValue placeholder="Choose a node" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {nodeLabel(candidate.name, candidate.id)}
                    {!candidate.inLayout && ' — no role yet'}
                    {!candidate.isUp && ' (down)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="staging-zone" className="text-xs">
              Zone
            </Label>
            <Input
              id="staging-zone"
              className="w-40"
              list="staging-zones"
              value={zone}
              onChange={(e) => edit({ zone: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            <datalist id="staging-zones">
              {liveZones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="staging-capacity" className="text-xs">
              Capacity
            </Label>
            <div className="flex gap-1">
              <Input
                id="staging-capacity"
                className="w-24"
                inputMode="decimal"
                value={capacityValue}
                disabled={gateway}
                onChange={(e) => edit({ capacityValue: e.target.value })}
              />
              <Select
                value={capacityUnit}
                onValueChange={(v) => edit({ capacityUnit: v as CapacityUnit })}
              >
                <SelectTrigger className="w-20" aria-label="Capacity unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(CAPACITY_UNIT_BYTES) as CapacityUnit[]).map(
                    (unit) => (
                      <SelectItem key={unit} value={unit}>
                        {unit}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="staging-gateway" className="text-xs">
              Gateway
            </Label>
            <div className="flex h-9 items-center">
              <Switch
                id="staging-gateway"
                checked={gateway}
                onCheckedChange={(checked) => edit({ gateway: checked })}
              />
            </div>
          </div>

          <div className="flex-1 space-y-1.5">
            <Label htmlFor="staging-tags" className="text-xs">
              Tags (comma separated)
            </Label>
            <Input
              id="staging-tags"
              value={tagsText}
              onChange={(e) => edit({ tagsText: e.target.value })}
              placeholder="ssd, name:vault-01"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>

        {isNewZone && (
          <Badge variant="outline" className="text-amber-600">
            New zone
          </Badge>
        )}

        {error && (
          <p className="text-destructive flex items-center gap-2 text-sm">
            <TriangleAlert className="h-4 w-4" />
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={stageAssign} disabled={submitting || error !== null}>
            {submitting ? 'Staging…' : 'Stage change'}
          </Button>

          <ConfirmDeleteDialog
            trigger={
              <Button variant="outline" disabled={submitting || !selected}>
                Stage removal
              </Button>
            }
            title={`Stage the removal of ${label}?`}
            description={
              <>
                <p>
                  This stages a removal. Nothing leaves the layout until you run{' '}
                  <code>garage layout apply</code> on a cluster host — and when
                  you do, Garage will move every partition this node holds
                  elsewhere.
                </p>
                <p>
                  It cannot be un-staged from here: only{' '}
                  <code>garage layout revert</code> clears the staging area.
                </p>
              </>
            }
            confirmText={label}
            confirmLabel="Stage removal"
            pendingLabel="Staging…"
            variant="destructive"
            onConfirm={() => onStage({ action: 'remove', nodeId })}
          />
        </div>
      </CardContent>
    </Card>
  );
}
