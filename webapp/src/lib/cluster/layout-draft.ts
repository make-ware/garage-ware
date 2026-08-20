import { GIGABYTE, TERABYTE } from '@/lib/storage/units';
import { parseNodeTags } from '@/lib/node-label';
import type { SimNodeInput, SimResult, SimZoneRedundancy } from './layout-sim';

/**
 * The planner's editable state, and every pure function that reads it.
 *
 * Split out of the page so "what did the operator change" is testable without
 * rendering anything: the reducer, the field validation, the live-layout diff
 * and the `garage layout` commands the diff implies are all plain data in,
 * plain data out. The page is then wiring.
 *
 * **Capacity is held as the string the operator typed**, plus a unit, and is
 * only parsed on the way into the simulation. Storing a number would rewrite
 * `1.` to `1` under the cursor and make `0.5` unreachable one keystroke at a
 * time — the same reason the quota inputs elsewhere in the app keep their raw
 * text. It also means an unparseable value is a *field* state, not a
 * simulation failure.
 *
 * Like `layout-sim.ts`, everything here is in **bytes**, never GB: see that
 * file's hazard note. `GIGABYTE`/`TERABYTE` are constants, not the `gb*`
 * conversion helpers, so nothing in `lib/cluster/` carries a `gb`-named value
 * that could typecheck into a ledger call site.
 */

/** The two units the capacity field offers. Garage's own figures are SI. */
export type CapacityUnit = 'GB' | 'TB';

export const CAPACITY_UNIT_BYTES: Record<CapacityUnit, number> = {
  GB: GIGABYTE,
  TB: TERABYTE,
};

export interface DraftNode {
  /**
   * Stable identity of the *row*. For a node already in the layout this is its
   * node key; for a hypothetical it is `new-1`, `new-2`, … A row key rather
   * than an array index because rows are removed from the middle, and an index
   * key would hand the removed row's edits to its neighbour.
   */
  key: string;
  /** The node key, when this row describes a node that exists. */
  nodeId: string | null;
  /** From the node's `name:` tag; hypotheticals have none. */
  name: string | null;
  zone: string;
  gateway: boolean;
  /** Exactly what the operator typed — see the module docblock. */
  capacityValue: string;
  capacityUnit: CapacityUnit;
}

export interface LayoutDraft {
  nodes: DraftNode[];
  replicationFactor: number;
  zoneRedundancy: SimZoneRedundancy;
  /** Counter behind `new-N` keys, so a removed row's key is never reused. */
  nextKey: number;
}

/** One layout role, structurally typed so this module never imports `lib/garage`. */
export interface LiveRole {
  /** Node **key** — the routes never emit a full id. */
  id: string;
  zone: string;
  capacity?: number | null;
  tags?: readonly string[];
}

/**
 * Pick the largest unit that renders the capacity without inventing precision.
 * A 16 TB node should read "16 TB", not "16000 GB"; 500 GB must not become
 * "0.5 TB", which an operator would read as a different number.
 */
export function splitCapacity(bytes: number): {
  value: string;
  unit: CapacityUnit;
} {
  if (bytes >= TERABYTE && Number.isInteger(bytes / TERABYTE)) {
    return { value: String(bytes / TERABYTE), unit: 'TB' };
  }
  const inGigabytes = bytes / GIGABYTE;
  if (inGigabytes >= 1000) {
    return { value: trim(bytes / TERABYTE), unit: 'TB' };
  }
  return { value: trim(inGigabytes), unit: 'GB' };
}

function trim(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * Seed the planner from the cluster as it stands.
 *
 * The starting draft is deliberately the *current* layout rather than an empty
 * table: a what-if is a comparison, and an operator who has to retype seven
 * nodes before asking a question will type at least one of them wrong.
 */
export function draftFromLive(
  roles: readonly LiveRole[],
  replicationFactor: number,
  zoneRedundancy: SimZoneRedundancy
): LayoutDraft {
  return {
    nodes: roles.map((role) => {
      const gateway = role.capacity === null || role.capacity === undefined;
      const { value, unit } = gateway
        ? { value: '', unit: 'TB' as CapacityUnit }
        : splitCapacity(role.capacity ?? 0);
      return {
        key: role.id,
        nodeId: role.id,
        name: parseNodeTags(role.tags).name,
        zone: role.zone,
        gateway,
        capacityValue: value,
        capacityUnit: unit,
      };
    }),
    replicationFactor,
    zoneRedundancy,
    nextKey: 1,
  };
}

export type DraftAction =
  | { type: 'edit-capacity'; key: string; value: string }
  | { type: 'edit-unit'; key: string; unit: CapacityUnit }
  | { type: 'edit-zone'; key: string; zone: string }
  | { type: 'toggle-gateway'; key: string }
  | { type: 'add-node' }
  | { type: 'remove-node'; key: string }
  | { type: 'set-replication-factor'; value: number }
  | { type: 'set-zone-redundancy'; value: SimZoneRedundancy }
  | { type: 'reset'; draft: LayoutDraft };

export function draftReducer(
  state: LayoutDraft,
  action: DraftAction
): LayoutDraft {
  const patch = (key: string, change: Partial<DraftNode>): LayoutDraft => ({
    ...state,
    nodes: state.nodes.map((n) => (n.key === key ? { ...n, ...change } : n)),
  });

  switch (action.type) {
    case 'edit-capacity':
      return patch(action.key, { capacityValue: action.value });
    case 'edit-unit':
      return patch(action.key, { capacityUnit: action.unit });
    case 'edit-zone':
      return patch(action.key, { zone: action.zone });
    case 'toggle-gateway': {
      const node = state.nodes.find((n) => n.key === action.key);
      if (!node) return state;
      // Turning a gateway back into a storage node leaves the field empty
      // rather than guessing a capacity — an invented number here would be
      // simulated as fact.
      return patch(action.key, { gateway: !node.gateway });
    }
    case 'add-node': {
      // A new row inherits the last row's zone: the common case is adding a
      // second node to a zone that already exists, and it is also the case a
      // typo turns into a brand-new zone with quietly different consequences.
      const zone = state.nodes[state.nodes.length - 1]?.zone ?? '';
      return {
        ...state,
        nextKey: state.nextKey + 1,
        nodes: [
          ...state.nodes,
          {
            key: `new-${state.nextKey}`,
            nodeId: null,
            name: null,
            zone,
            gateway: false,
            capacityValue: '',
            capacityUnit: 'TB',
          },
        ],
      };
    }
    case 'remove-node':
      return {
        ...state,
        nodes: state.nodes.filter((n) => n.key !== action.key),
      };
    case 'set-replication-factor':
      return { ...state, replicationFactor: action.value };
    case 'set-zone-redundancy':
      return { ...state, zoneRedundancy: action.value };
    case 'reset':
      return action.draft;
  }
}

/**
 * What is wrong with this row, in words, or `null`.
 *
 * `0` is rejected explicitly and separately from "not a number": Garage treats
 * a missing capacity as *gateway* and there is no such thing as a storage node
 * with no capacity, so a 0 typed into the capacity field means the operator
 * wanted the gateway switch.
 */
export function draftNodeError(node: DraftNode): string | null {
  // Every layout node needs a zone, gateway or not — Garage's `-z` flag is
  // mandatory regardless of whether `-g` is also set.
  if (!node.zone.trim()) return 'Zone is required';
  if (node.gateway) return null;
  const raw = node.capacityValue.trim();
  if (!raw) return 'Capacity is required';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 'Capacity must be a number';
  if (parsed === 0) return 'Use the gateway switch for a node with no capacity';
  if (parsed < 0) return 'Capacity must be positive';
  return null;
}

/** Duplicate row identities, which would silently collapse in the simulation. */
export function duplicateNodeKeys(draft: LayoutDraft): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const node of draft.nodes) {
    const id = node.nodeId ?? node.key;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

export function draftErrors(draft: LayoutDraft): string[] {
  const errors: string[] = [];
  for (const node of draft.nodes) {
    const error = draftNodeError(node);
    if (error) errors.push(`${node.name ?? node.key}: ${error}`);
  }
  for (const duplicate of duplicateNodeKeys(draft)) {
    errors.push(`${duplicate}: duplicate node`);
  }
  return errors;
}

/** A row's declared capacity in bytes, or `null` for a gateway / unparseable. */
export function nodeCapacityBytes(node: DraftNode): number | null {
  if (node.gateway) return null;
  const parsed = Number(node.capacityValue.trim());
  if (!node.capacityValue.trim() || !Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.round(parsed * CAPACITY_UNIT_BYTES[node.capacityUnit]);
}

/** The draft as the simulation reads it. Rows with field errors are dropped. */
export function toSimNodes(draft: LayoutDraft): SimNodeInput[] {
  return draft.nodes
    .filter((node) => draftNodeError(node) === null)
    .map((node) => ({
      id: node.key,
      zone: node.zone.trim(),
      capacityBytes: nodeCapacityBytes(node),
    }));
}

/** Every zone named by a valid row, sorted — the zone combobox's options. */
export function draftZones(draft: LayoutDraft): string[] {
  return [
    ...new Set(draft.nodes.map((n) => n.zone.trim()).filter(Boolean)),
  ].sort();
}

export interface DraftChange {
  key: string;
  label: string;
  nodeId: string | null;
  kind: 'added' | 'removed' | 'moved' | 'resized' | 'gateway';
  fromZone: string | null;
  toZone: string | null;
  fromCapacityBytes: number | null;
  toCapacityBytes: number | null;
}

export interface DraftDiff {
  changes: DraftChange[];
  /** Zones the draft introduces that the live layout does not have. */
  newZones: string[];
  dirty: boolean;
}

/**
 * What the draft would change about the live layout.
 *
 * `newZones` is called out separately because introducing a zone is the one
 * edit that can *reduce* capacity while looking like an addition: under
 * `maximum` zone redundancy the effective `k` is `min(zones, rf)`, so a fourth
 * zone tightens every zone's `rf − k + 1` at once. A zone-name typo —
 * `dc1` against `DC1` — does exactly that, silently, which is why the zone
 * field is a combobox over the zones that already exist rather than free text.
 */
export function diffDraft(
  live: readonly LiveRole[],
  draft: LayoutDraft
): DraftDiff {
  const liveByKey = new Map(live.map((role) => [role.id, role]));
  const changes: DraftChange[] = [];

  for (const node of draft.nodes) {
    const label = node.name ?? node.nodeId ?? node.key;
    const toCapacity = nodeCapacityBytes(node);
    const role = node.nodeId ? liveByKey.get(node.nodeId) : undefined;
    if (!role) {
      changes.push({
        key: node.key,
        label,
        nodeId: node.nodeId,
        kind: 'added',
        fromZone: null,
        toZone: node.zone.trim(),
        fromCapacityBytes: null,
        toCapacityBytes: toCapacity,
      });
      continue;
    }
    const fromCapacity = role.capacity ?? null;
    const movedZone = role.zone !== node.zone.trim();
    const changedCapacity = fromCapacity !== toCapacity;
    if (!movedZone && !changedCapacity) continue;
    changes.push({
      key: node.key,
      label,
      nodeId: node.nodeId,
      kind: movedZone
        ? 'moved'
        : toCapacity === null || fromCapacity === null
          ? 'gateway'
          : 'resized',
      fromZone: role.zone,
      toZone: node.zone.trim(),
      fromCapacityBytes: fromCapacity,
      toCapacityBytes: toCapacity,
    });
  }

  const draftIds = new Set(
    draft.nodes.map((n) => n.nodeId).filter((id): id is string => id !== null)
  );
  for (const role of live) {
    if (draftIds.has(role.id)) continue;
    changes.push({
      key: role.id,
      label: parseNodeTags(role.tags).name ?? role.id,
      nodeId: role.id,
      kind: 'removed',
      fromZone: role.zone,
      toZone: null,
      fromCapacityBytes: role.capacity ?? null,
      toCapacityBytes: null,
    });
  }

  const liveZones = new Set(live.map((role) => role.zone));
  const newZones = [
    ...new Set(
      draft.nodes
        .map((n) => n.zone.trim())
        .filter((zone) => zone && !liveZones.has(zone))
    ),
  ].sort();

  return { changes, newZones, dirty: changes.length > 0 };
}

/**
 * The `garage layout` command lines this diff implies.
 *
 * The planner deliberately stops here. Staging the change from the app would
 * make it a mutation tool, and there is no safe undo — `garage layout revert`
 * clears the staging area by incrementing the layout version. So the operator
 * gets the exact commands and runs them where they can see the result of
 * `garage layout show` before applying.
 */
export function draftCommands(diff: DraftDiff): string[] {
  const lines: string[] = [];
  for (const change of diff.changes) {
    if (change.kind === 'removed') {
      lines.push(`garage layout remove ${change.nodeId}`);
      continue;
    }
    const target = change.nodeId ?? `<node-id for ${change.label}>`;
    const capacity =
      change.toCapacityBytes === null
        ? '-g'
        : `-c ${capacityFlag(change.toCapacityBytes)}`;
    lines.push(
      `garage layout assign ${target} -z ${change.toZone} ${capacity}`
    );
  }
  if (lines.length > 0) lines.push('garage layout show', 'garage layout apply');
  return lines;
}

/** `-c` takes a human size; keep the operator's own unit rather than bytes. */
function capacityFlag(bytes: number): string {
  const { value, unit } = splitCapacity(bytes);
  return `${value}${unit}`;
}

export interface CapacityImpact {
  /** `null` when that side of the comparison has no feasible layout. */
  beforeBytes: number | null;
  afterBytes: number | null;
  /** The plan reduces the cluster's effective capacity. */
  regression: boolean;
  newZones: string[];
  /**
   * A new zone raised the effective zone redundancy under `maximum` — the
   * mechanism behind a capacity-*destroying* change that reads as an addition.
   */
  zoneRedundancyRaised: boolean;
}

export function capacityImpact(
  before: SimResult,
  after: SimResult,
  newZones: readonly string[]
): CapacityImpact {
  const beforeBytes = before.ok ? before.exact.effectiveCapacityBytes : null;
  const afterBytes = after.ok ? after.exact.effectiveCapacityBytes : null;
  return {
    beforeBytes,
    afterBytes,
    regression:
      beforeBytes !== null && (afterBytes === null || afterBytes < beforeBytes),
    newZones: [...newZones],
    zoneRedundancyRaised:
      before.ok &&
      after.ok &&
      after.exact.effectiveZoneRedundancy >
        before.exact.effectiveZoneRedundancy,
  };
}

/**
 * Garage's `zoneRedundancy` parameter as the planner models it.
 *
 * Tolerant of a missing or unrecognised value — the layout route passes the
 * parameter through from Garage, older releases have carried other shapes, and
 * a planner that refuses to load because a field it did not need is unfamiliar
 * is worse than one that starts from `maximum` (which is Garage's own default).
 */
export function parseZoneRedundancy(value: unknown): SimZoneRedundancy {
  if (value === 'maximum') return { mode: 'maximum' };
  if (
    typeof value === 'object' &&
    value !== null &&
    'atLeast' in value &&
    typeof (value as { atLeast: unknown }).atLeast === 'number'
  ) {
    return { mode: 'atLeast', atLeast: (value as { atLeast: number }).atLeast };
  }
  return { mode: 'maximum' };
}
