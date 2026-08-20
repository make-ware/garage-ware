import { describe, expect, it } from 'vitest';
import {
  capacityImpact,
  diffDraft,
  draftCommands,
  draftErrors,
  draftFromLive,
  draftNodeError,
  draftReducer,
  draftZones,
  nodeCapacityBytes,
  parseZoneRedundancy,
  splitCapacity,
  toSimNodes,
  type DraftNode,
  type LayoutDraft,
  type LiveRole,
} from './layout-draft';
import { simulateLayout } from './layout-sim';

const TB = 1_000_000_000_000;
const GB = 1_000_000_000;
const MAXIMUM = { mode: 'maximum' } as const;

/** Three 16 TB nodes across three zones — the shape most clusters start at. */
const LIVE: LiveRole[] = [
  {
    id: 'aaaa000000000001',
    zone: 'dc1',
    capacity: 16 * TB,
    tags: ['name:alpha'],
  },
  { id: 'aaaa000000000002', zone: 'dc2', capacity: 16 * TB, tags: [] },
  {
    id: 'aaaa000000000003',
    zone: 'dc3',
    capacity: 16 * TB,
    tags: ['name:gamma'],
  },
];

function baseDraft(): LayoutDraft {
  return draftFromLive(LIVE, 3, MAXIMUM);
}

function row(draft: LayoutDraft, key: string): DraftNode {
  const found = draft.nodes.find((n) => n.key === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
}

describe('splitCapacity', () => {
  it('prefers the unit that renders the operator’s own number', () => {
    expect(splitCapacity(16 * TB)).toEqual({ value: '16', unit: 'TB' });
    expect(splitCapacity(500 * GB)).toEqual({ value: '500', unit: 'GB' });
    // 500 GB must not become "0.5 TB" — a different number to read back.
    expect(splitCapacity(1500 * GB)).toEqual({ value: '1.5', unit: 'TB' });
    expect(splitCapacity(1_000_000_000)).toEqual({ value: '1', unit: 'GB' });
  });
});

describe('draftFromLive', () => {
  it('seeds the table from the cluster as it stands', () => {
    const draft = baseDraft();
    expect(draft.nodes).toHaveLength(3);
    expect(draft.nodes[0]).toMatchObject({
      key: 'aaaa000000000001',
      nodeId: 'aaaa000000000001',
      name: 'alpha',
      zone: 'dc1',
      gateway: false,
      capacityValue: '16',
      capacityUnit: 'TB',
    });
    // An untagged node has no name; the row falls back to its key on screen.
    expect(draft.nodes[1].name).toBeNull();
  });

  it('treats a role with no capacity as a gateway', () => {
    const draft = draftFromLive(
      [{ id: 'gw', zone: 'dc1', capacity: null, tags: [] }],
      3,
      MAXIMUM
    );
    expect(draft.nodes[0]).toMatchObject({ gateway: true, capacityValue: '' });
  });
});

describe('draftReducer', () => {
  it('edits one row and leaves the rest identical', () => {
    const before = baseDraft();
    const after = draftReducer(before, {
      type: 'edit-capacity',
      key: 'aaaa000000000002',
      value: '32',
    });
    expect(row(after, 'aaaa000000000002').capacityValue).toBe('32');
    expect(row(after, 'aaaa000000000001')).toBe(
      row(before, 'aaaa000000000001')
    );
  });

  it('adds a row inheriting the last row’s zone, with a fresh key', () => {
    // The common addition is a second node in an existing zone — and it is
    // also the edit a zone typo turns into a brand-new zone.
    const added = draftReducer(baseDraft(), { type: 'add-node' });
    expect(added.nodes).toHaveLength(4);
    expect(added.nodes[3]).toMatchObject({
      key: 'new-1',
      nodeId: null,
      zone: 'dc3',
      capacityValue: '',
    });
    expect(added.nextKey).toBe(2);
  });

  it('never reuses the key of a removed row', () => {
    // A reused key would hand the removed row's identity — and its baseline
    // partition count — to a different node.
    let draft = draftReducer(baseDraft(), { type: 'add-node' });
    draft = draftReducer(draft, { type: 'remove-node', key: 'new-1' });
    draft = draftReducer(draft, { type: 'add-node' });
    expect(draft.nodes.map((n) => n.key)).toContain('new-2');
    expect(draft.nodes.map((n) => n.key)).not.toContain('new-1');
  });

  it('clears nothing when a node is switched to a gateway and back', () => {
    let draft = draftReducer(baseDraft(), {
      type: 'toggle-gateway',
      key: 'aaaa000000000001',
    });
    expect(row(draft, 'aaaa000000000001').gateway).toBe(true);
    draft = draftReducer(draft, {
      type: 'toggle-gateway',
      key: 'aaaa000000000001',
    });
    expect(row(draft, 'aaaa000000000001')).toMatchObject({
      gateway: false,
      capacityValue: '16',
    });
  });

  it('carries the replication factor and zone redundancy', () => {
    let draft = draftReducer(baseDraft(), {
      type: 'set-replication-factor',
      value: 2,
    });
    draft = draftReducer(draft, {
      type: 'set-zone-redundancy',
      value: { mode: 'atLeast', atLeast: 1 },
    });
    expect(draft.replicationFactor).toBe(2);
    expect(draft.zoneRedundancy).toEqual({ mode: 'atLeast', atLeast: 1 });
  });

  it('restores the live layout on reset', () => {
    const original = baseDraft();
    const edited = draftReducer(original, { type: 'add-node' });
    expect(draftReducer(edited, { type: 'reset', draft: original })).toBe(
      original
    );
  });
});

describe('draftNodeError', () => {
  const base: DraftNode = {
    key: 'x',
    nodeId: null,
    name: null,
    zone: 'dc1',
    gateway: false,
    capacityValue: '10',
    capacityUnit: 'TB',
  };

  it('accepts a well-formed row', () => {
    expect(draftNodeError(base)).toBeNull();
  });

  it('sends a zero capacity to the gateway switch', () => {
    // Garage has no such thing as a storage node with no capacity: a missing
    // capacity *is* what makes a node a gateway.
    expect(draftNodeError({ ...base, capacityValue: '0' })).toMatch(/gateway/);
  });

  it('rejects an empty, negative or unparseable capacity', () => {
    expect(draftNodeError({ ...base, capacityValue: '' })).toMatch(/required/);
    expect(draftNodeError({ ...base, capacityValue: '-4' })).toMatch(
      /positive/
    );
    expect(draftNodeError({ ...base, capacityValue: 'ten' })).toMatch(/number/);
  });

  it('requires a zone for a storage node and for a gateway alike', () => {
    expect(draftNodeError({ ...base, zone: '  ' })).toMatch(/Zone/);
    expect(draftNodeError({ ...base, zone: '  ', gateway: true })).toMatch(
      /Zone/
    );
  });

  it('reports a duplicate node identity through draftErrors', () => {
    const draft = baseDraft();
    draft.nodes.push({ ...draft.nodes[0] });
    expect(draftErrors(draft)).toContain('aaaa000000000001: duplicate node');
  });
});

describe('nodeCapacityBytes / toSimNodes', () => {
  it('converts through the row’s own unit', () => {
    const draft = baseDraft();
    expect(nodeCapacityBytes(row(draft, 'aaaa000000000001'))).toBe(16 * TB);
  });

  it('drops rows the operator has not finished typing', () => {
    // A half-typed row must not collapse the whole simulation — it is a field
    // state, not a cluster that cannot exist.
    const draft = draftReducer(baseDraft(), { type: 'add-node' });
    expect(toSimNodes(draft)).toHaveLength(3);
  });

  it('keys the simulation on the row key, so a new node has no baseline', () => {
    const draft = draftReducer(baseDraft(), { type: 'add-node' });
    const filled = draftReducer(draft, {
      type: 'edit-capacity',
      key: 'new-1',
      value: '16',
    });
    expect(toSimNodes(filled).map((n) => n.id)).toEqual([
      'aaaa000000000001',
      'aaaa000000000002',
      'aaaa000000000003',
      'new-1',
    ]);
  });

  it('lists the zones in play', () => {
    expect(draftZones(baseDraft())).toEqual(['dc1', 'dc2', 'dc3']);
  });
});

describe('diffDraft', () => {
  it('sees nothing when nothing was touched', () => {
    expect(diffDraft(LIVE, baseDraft())).toEqual({
      changes: [],
      newZones: [],
      dirty: false,
    });
  });

  it('names a resize, a move, a removal and an addition', () => {
    let draft = draftReducer(baseDraft(), {
      type: 'edit-capacity',
      key: 'aaaa000000000001',
      value: '32',
    });
    draft = draftReducer(draft, {
      type: 'edit-zone',
      key: 'aaaa000000000002',
      zone: 'dc3',
    });
    draft = draftReducer(draft, {
      type: 'remove-node',
      key: 'aaaa000000000003',
    });
    draft = draftReducer(draft, { type: 'add-node' });
    draft = draftReducer(draft, {
      type: 'edit-capacity',
      key: 'new-1',
      value: '8',
    });

    const diff = diffDraft(LIVE, draft);
    expect(diff.dirty).toBe(true);
    expect(diff.changes.map((c) => [c.label, c.kind])).toEqual([
      ['alpha', 'resized'],
      ['aaaa000000000002', 'moved'],
      ['new-1', 'added'],
      ['gamma', 'removed'],
    ]);
    expect(diff.changes[0]).toMatchObject({
      fromCapacityBytes: 16 * TB,
      toCapacityBytes: 32 * TB,
    });
  });

  it('calls out a zone the live layout does not have', () => {
    // The one edit that can *reduce* capacity while reading as an addition —
    // and a `dc1` / `DC1` typo does it silently.
    const draft = draftReducer(baseDraft(), {
      type: 'edit-zone',
      key: 'aaaa000000000003',
      zone: 'DC1',
    });
    expect(diffDraft(LIVE, draft).newZones).toEqual(['DC1']);
  });
});

describe('draftCommands', () => {
  it('emits assign and remove lines, then show and apply', () => {
    // The planner stops at the command text on purpose: staging from the app
    // would make it a mutation tool, and `garage layout revert` is not an undo
    // — it clears staging by incrementing the layout version.
    let draft = draftReducer(baseDraft(), {
      type: 'edit-capacity',
      key: 'aaaa000000000001',
      value: '32',
    });
    draft = draftReducer(draft, {
      type: 'remove-node',
      key: 'aaaa000000000003',
    });
    expect(draftCommands(diffDraft(LIVE, draft))).toEqual([
      'garage layout assign aaaa000000000001 -z dc1 -c 32TB',
      'garage layout remove aaaa000000000003',
      'garage layout show',
      'garage layout apply',
    ]);
  });

  it('emits nothing at all for an unchanged draft', () => {
    expect(draftCommands(diffDraft(LIVE, baseDraft()))).toEqual([]);
  });

  it('marks a hypothetical node, which has no id to assign yet', () => {
    let draft = draftReducer(baseDraft(), { type: 'add-node' });
    draft = draftReducer(draft, {
      type: 'edit-capacity',
      key: 'new-1',
      value: '8',
    });
    expect(draftCommands(diffDraft(LIVE, draft))[0]).toContain(
      '<node-id for new-1>'
    );
  });

  it('uses -g for a node turned into a gateway', () => {
    const draft = draftReducer(baseDraft(), {
      type: 'toggle-gateway',
      key: 'aaaa000000000002',
    });
    expect(draftCommands(diffDraft(LIVE, draft))[0]).toBe(
      'garage layout assign aaaa000000000002 -z dc2 -g'
    );
  });
});

describe('capacityImpact', () => {
  const sim = (nodes: LiveRole[], replicationFactor = 3) =>
    simulateLayout({
      nodes: nodes.map((r) => ({
        id: r.id,
        zone: r.zone,
        capacityBytes: r.capacity ?? null,
      })),
      replicationFactor,
      zoneRedundancy: MAXIMUM,
    });

  it('reports no regression for a plain capacity increase', () => {
    const before = sim(LIVE);
    const after = sim(
      LIVE.map((r) => ({ ...r, capacity: (r.capacity ?? 0) * 2 }))
    );
    expect(capacityImpact(before, after, [])).toMatchObject({
      regression: false,
      zoneRedundancyRaised: false,
    });
  });

  it('catches a new small zone destroying capacity under `maximum`', () => {
    // The `maximum` trap, and the reason the zone field is a combobox rather
    // than free text. With two zones, `k = min(2, 3) = 2`, so each zone may
    // hold two replicas of a partition and 64 TB of declared disk yields
    // ~21 TB effective. Add a *third* zone — even a 1 GB one, even by
    // mistyping `dc1` as `DC1` — and `k` becomes 3: every zone is now capped
    // at one replica per partition, so the new zone has to carry a full third
    // of the ring, and 1 GB is what the whole cluster can hold.
    const twoZones: LiveRole[] = [
      { id: 'a', zone: 'dc1', capacity: 16 * TB, tags: [] },
      { id: 'b', zone: 'dc1', capacity: 16 * TB, tags: [] },
      { id: 'c', zone: 'dc2', capacity: 16 * TB, tags: [] },
      { id: 'd', zone: 'dc2', capacity: 16 * TB, tags: [] },
    ];
    const before = sim(twoZones);
    const after = sim([
      ...twoZones,
      { id: 'tiny', zone: 'dc3', capacity: 1 * GB, tags: [] },
    ]);
    const impact = capacityImpact(before, after, ['dc3']);
    expect(impact.regression).toBe(true);
    expect(impact.zoneRedundancyRaised).toBe(true);
    expect(impact.newZones).toEqual(['dc3']);
    expect(impact.afterBytes!).toBeLessThan(impact.beforeBytes!);
    // 1 GB / 256 lands exactly on a partition size, so this is the whole of it.
    expect(impact.afterBytes).toBe(1 * GB);
  });

  it('treats an infeasible plan as a regression, not as unknown', () => {
    const before = sim(LIVE);
    const after = sim(LIVE.slice(0, 1));
    expect(capacityImpact(before, after, [])).toMatchObject({
      regression: true,
      afterBytes: null,
    });
  });
});

describe('parseZoneRedundancy', () => {
  it('reads both shapes Garage uses', () => {
    expect(parseZoneRedundancy('maximum')).toEqual({ mode: 'maximum' });
    expect(parseZoneRedundancy({ atLeast: 2 })).toEqual({
      mode: 'atLeast',
      atLeast: 2,
    });
  });

  it('falls back to Garage’s own default rather than refusing to load', () => {
    // The planner should not fail to open because a parameter it did not need
    // arrived in an unfamiliar shape from an older release.
    expect(parseZoneRedundancy(undefined)).toEqual({ mode: 'maximum' });
    expect(parseZoneRedundancy({ somethingElse: 1 })).toEqual({
      mode: 'maximum',
    });
  });
});
