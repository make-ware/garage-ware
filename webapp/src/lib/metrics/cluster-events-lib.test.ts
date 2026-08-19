import { describe, expect, it } from 'vitest';
// A Goja CommonJS module from the PocketBase hooks, imported across the
// workspace boundary for the same reason node-metrics-lib.test.ts imports
// `bucketHistory`: the differ is what decides whether a cluster change is ever
// recorded at all, and it runs somewhere with no test runner. Its top level
// touches no PocketBase globals and makes no requires, so it loads fine here;
// it carries no types, hence the local interface.
import {
  CLUSTER_DROP_RATIO,
  DATA_DROP_MIN_BYTES,
  DATA_DROP_PCT,
  DISK_CHANGE_TOLERANCE,
  FLAP_WINDOW_SEC,
  ONGOING_KINDS,
  conditionActive,
  diffObservations,
  reconcileOngoing,
} from '../../../../pocketbase/pb_hooks/lib/cluster-events.js';
import { ONGOING_KINDS as SHARED_ONGOING_KINDS } from '@garage-ware/shared';

interface Observation {
  node_id: string;
  node_hostname: string;
  node_zone: string;
  is_up: boolean;
  layout_ok: boolean;
  role_ok: boolean;
  role_capacity_bytes: number;
  node_tags: string;
  layout_version: number;
  garage_version: string;
  data_total_bytes: number;
  data_available_bytes: number;
  meta_total_bytes: number;
  meta_available_bytes: number;
}

interface Event {
  kind: string;
  source: string;
  severity: string;
  node_id: string;
  title: string;
  detail: string;
  previous_value: string;
  new_value: string;
  /** True when this event OPENS a condition rather than recording an instant. */
  ongoing: boolean;
}

/** A row as `readOpenConditions` hands it to `reconcileOngoing`. */
interface OpenRow {
  id: string;
  kind: string;
  node_id: string;
  /** '' for open; any value means closed, and inside the flap window. */
  ended_at: string;
  occurrence_count: number;
}

interface Plan {
  creates: Event[];
  reopens: Array<{ id: string; occurrence_count: number }>;
  closes: Array<{ id: string }>;
}

function openRow(over: Partial<OpenRow> = {}): OpenRow {
  return {
    id: 'row1',
    kind: 'node_state',
    node_id: 'a1b2c3d4e5f6',
    ended_at: '',
    occurrence_count: 1,
    ...over,
  };
}

const TB = 1e12;

/** A healthy storage node holding half of an 8 TB data drive. */
function node(over: Partial<Observation> = {}): Observation {
  return {
    node_id: 'a1b2c3d4e5f6',
    node_hostname: 'vault-01',
    node_zone: 'dc1',
    is_up: true,
    layout_ok: true,
    role_ok: true,
    role_capacity_bytes: 8 * TB,
    node_tags: 'ssd,name:vault-01',
    layout_version: 12,
    garage_version: '2.3.0',
    data_total_bytes: 8 * TB,
    data_available_bytes: 4 * TB,
    meta_total_bytes: 500e9,
    meta_available_bytes: 400e9,
    ...over,
  };
}

const kinds = (events: Event[]) => events.map((e) => e.kind).sort();

describe('diffObservations', () => {
  it('emits nothing when nothing changed', () => {
    expect(diffObservations([node()], [node()])).toEqual([]);
  });

  it('emits nothing for a node with no previous observation', () => {
    // A brand-new node, and equally the first run after a gap in the cron:
    // "we were not looking" is not "nothing happened".
    expect(diffObservations([], [node()])).toEqual([]);
  });

  it('tags every event it does emit as coming from the detector', () => {
    const events: Event[] = diffObservations(
      [node()],
      [node({ is_up: false })]
    );
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('detector');
  });

  describe('the role_ok upgrade guard', () => {
    it('does not read a pre-migration row as a capacity of zero', () => {
      // The whole point of the gate. Rows written before role_capacity_bytes
      // existed read back as 0, and 0 is also a legitimate gateway reading —
      // without role_ok every storage node would report 0 → 8 TB on the first
      // scrape after the upgrade.
      const before = node({
        role_ok: false,
        role_capacity_bytes: 0,
        node_tags: '',
      });
      expect(diffObservations([before], [node()])).toEqual([]);
    });

    it('still reports the status-derived changes on such a row', () => {
      // role_ok gates the layout fields only. Connectivity and disk size come
      // from GetClusterStatus and are readable on any row. Going offline is
      // used rather than coming back, because a recovery is no longer an event
      // at all — it closes the row the outage opened.
      const before = node({
        role_ok: false,
        role_capacity_bytes: 0,
        node_tags: '',
      });
      const after = node({
        role_ok: false,
        role_capacity_bytes: 0,
        node_tags: '',
        is_up: false,
      });
      expect(kinds(diffObservations([before], [after]))).toEqual([
        'node_state',
      ]);
    });

    it('is silent when the current scrape could not read the layout', () => {
      const after = node({
        role_ok: false,
        role_capacity_bytes: 0,
        node_tags: '',
      });
      expect(diffObservations([node()], [after])).toEqual([]);
    });
  });

  describe('layout role', () => {
    it('reports a capacity increase as info', () => {
      const events: Event[] = diffObservations(
        [node()],
        [node({ role_capacity_bytes: 16 * TB })]
      );
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('capacity_changed');
      expect(events[0].severity).toBe('info');
      expect(events[0].previous_value).toBe(String(8 * TB));
      expect(events[0].new_value).toBe(String(16 * TB));
    });

    it('reports a capacity decrease as a warning', () => {
      const events: Event[] = diffObservations(
        [node()],
        [node({ role_capacity_bytes: 4 * TB })]
      );
      expect(events[0].kind).toBe('capacity_changed');
      expect(events[0].severity).toBe('warning');
    });

    it('reads 0 → N as a node joining the layout', () => {
      const before = node({ role_capacity_bytes: 0 });
      expect(kinds(diffObservations([before], [node()]))).toEqual([
        'node_added',
      ]);
    });

    it('reads N → 0 as a node losing its role', () => {
      const after = node({ role_capacity_bytes: 0 });
      const events: Event[] = diffObservations([node()], [after]);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('node_removed');
      expect(events[0].severity).toBe('warning');
    });

    it('leaves a steady gateway alone', () => {
      // capacity 0 on both sides under role_ok is a real, unchanged reading:
      // a gateway is not a node that keeps being added and removed.
      const gateway = node({ role_capacity_bytes: 0, node_zone: '' });
      expect(diffObservations([gateway], [gateway])).toEqual([]);
    });

    it('reports a rename, which arrives as a tag change', () => {
      const events: Event[] = diffObservations(
        [node()],
        [node({ node_tags: 'ssd,name:vault-01-new' })]
      );
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('tags_changed');
      expect(events[0].new_value).toBe('ssd,name:vault-01-new');
    });

    it('reports a zone move', () => {
      expect(
        kinds(diffObservations([node()], [node({ node_zone: 'dc2' })]))
      ).toEqual(['zone_changed']);
    });

    it('does not call an appearing zone a zone change', () => {
      // "" means the node has no role; a role appearing is node_added's job.
      const before = node({ node_zone: '', role_capacity_bytes: 0 });
      expect(kinds(diffObservations([before], [node()]))).toEqual([
        'node_added',
      ]);
    });
  });

  describe('layout version', () => {
    it('emits exactly one cluster-scoped row however many nodes there are', () => {
      const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
      const before = ids.map((id) => node({ node_id: id, layout_version: 12 }));
      const after = ids.map((id) => node({ node_id: id, layout_version: 13 }));

      const events: Event[] = diffObservations(before, after);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('layout_version');
      expect(events[0].node_id).toBe('');
      expect(events[0].previous_value).toBe('12');
      expect(events[0].new_value).toBe('13');
    });

    it('says nothing when neither side could read the layout', () => {
      const blind = node({ role_ok: false, layout_version: 0 });
      expect(diffObservations([blind], [blind])).toEqual([]);
    });
  });

  describe('connectivity', () => {
    it('reports going offline as a warning', () => {
      const events: Event[] = diffObservations(
        [node()],
        [node({ is_up: false })]
      );
      expect(events[0].kind).toBe('node_state');
      expect(events[0].severity).toBe('warning');
      expect(events[0].new_value).toBe('down');
    });

    it('opens a condition rather than recording an instant', () => {
      const events: Event[] = diffObservations(
        [node()],
        [node({ is_up: false })]
      );
      expect(events[0].ongoing).toBe(true);
    });

    it('says nothing when a node comes back — the close pass owns that', () => {
      // There is deliberately no "back online" row any more. A recovery closes
      // the row the outage opened; filing a second, unlinked row beside it is
      // what made a flapping node unreadable on the timeline.
      expect(diffObservations([node({ is_up: false })], [node()])).toEqual([]);
    });

    it('is edge-triggered, so a node that stays down is not re-reported', () => {
      const down = node({ is_up: false });
      expect(diffObservations([down], [down])).toEqual([]);
    });
  });

  describe('disk size', () => {
    it('ignores movement inside the tolerance', () => {
      const jitter = 8 * TB * (1 + DISK_CHANGE_TOLERANCE / 2);
      expect(
        diffObservations([node()], [node({ data_total_bytes: jitter })])
      ).toEqual([]);
    });

    it('reports a data drive being replaced with a bigger one', () => {
      const events: Event[] = diffObservations(
        [node()],
        [node({ data_total_bytes: 16 * TB, data_available_bytes: 12 * TB })]
      );
      expect(kinds(events)).toEqual(['disk_changed']);
      expect(events[0].severity).toBe('info');
    });

    it('reports a shrinking partition as a warning', () => {
      const events: Event[] = diffObservations(
        [node()],
        [node({ data_total_bytes: 4 * TB, data_available_bytes: 3.9 * TB })]
      );
      const disk = events.find((e) => e.kind === 'disk_changed');
      expect(disk?.severity).toBe('warning');
    });

    it('treats a total of 0 as no reading rather than a vanished disk', () => {
      const after = node({ meta_total_bytes: 0, meta_available_bytes: 0 });
      expect(kinds(diffObservations([node()], [after]))).toEqual([]);
    });
  });

  describe('data drop', () => {
    // Half the drive gone: the fingerprint of a wiped data disk.
    const wiped = node({ data_available_bytes: 8 * TB - 0.1 * TB });

    it('flags a node that lost most of its data', () => {
      const events: Event[] = diffObservations([node()], [wiped]);
      const drop = events.find((e) => e.kind === 'data_drop');
      expect(drop).toBeDefined();
      expect(drop?.severity).toBe('critical');
    });

    it('does not flag a deletion the whole cluster shared in', () => {
      // Every node loses the same proportion: that is a bucket being emptied,
      // not a drive failing.
      const before = ['n1', 'n2', 'n3'].map((id) => node({ node_id: id }));
      const after = ['n1', 'n2', 'n3'].map((id) =>
        node({ node_id: id, data_available_bytes: 8 * TB - 0.1 * TB })
      );
      expect(kinds(diffObservations(before, after))).toEqual([]);
    });

    it('flags the one node that fell away from its peers', () => {
      const before = ['n1', 'n2', 'n3'].map((id) => node({ node_id: id }));
      const after = [
        node({ node_id: 'n1', data_available_bytes: 8 * TB - 0.1 * TB }),
        node({ node_id: 'n2' }),
        node({ node_id: 'n3' }),
      ];
      const events: Event[] = diffObservations(before, after);
      const drops = events.filter((e) => e.kind === 'data_drop');
      expect(drops).toHaveLength(1);
      expect(drops[0].node_id).toBe('n1');
    });

    it('ignores a drop below the percentage bar', () => {
      const shallow = 4 * TB + 4 * TB * (DATA_DROP_PCT / 2);
      expect(
        diffObservations([node()], [node({ data_available_bytes: shallow })])
      ).toEqual([]);
    });

    it('ignores a node holding too little for a percentage to mean anything', () => {
      const tiny = DATA_DROP_MIN_BYTES / 2;
      const before = node({
        data_total_bytes: DATA_DROP_MIN_BYTES,
        data_available_bytes: DATA_DROP_MIN_BYTES - tiny,
      });
      const after = node({
        data_total_bytes: DATA_DROP_MIN_BYTES,
        data_available_bytes: DATA_DROP_MIN_BYTES,
      });
      expect(kinds(diffObservations([before], [after]))).toEqual([]);
    });

    it('exports its bars so the copy and the guards cannot drift', () => {
      expect(DATA_DROP_PCT).toBeGreaterThan(0);
      expect(CLUSTER_DROP_RATIO).toBeGreaterThan(0);
      expect(CLUSTER_DROP_RATIO).toBeLessThanOrEqual(1);
    });
  });

  it('reports a Garage upgrade', () => {
    const events: Event[] = diffObservations(
      [node()],
      [node({ garage_version: '2.4.0' })]
    );
    expect(kinds(events)).toEqual(['version_changed']);
    expect(events[0].new_value).toBe('2.4.0');
  });

  it('does not call an appearing version string an upgrade', () => {
    expect(diffObservations([node({ garage_version: '' })], [node()])).toEqual(
      []
    );
  });

  it('reports a node Garage stopped listing at all', () => {
    // It writes no row of its own, so the per-node loop can never see it —
    // hence the separate pass over the previous set.
    const before = [node({ node_id: 'n1' }), node({ node_id: 'n2' })];
    const after = [node({ node_id: 'n1' })];

    const events: Event[] = diffObservations(before, after);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('node_removed');
    expect(events[0].node_id).toBe('n2');
    expect(events[0].severity).toBe('warning');
  });

  it('does not report a node whose row failed to write as removed', () => {
    // It is missing from `curRows` for a local reason, and saying the cluster
    // lost it would now cost an OPEN condition rather than one stray row.
    const before = [node({ node_id: 'n1' }), node({ node_id: 'n2' })];
    const after = [node({ node_id: 'n1' })];
    expect(diffObservations(before, after, ['n2'])).toEqual([]);
  });

  it('records several changes on one node as separate entries', () => {
    const events: Event[] = diffObservations(
      [node()],
      [
        node({
          is_up: false,
          role_capacity_bytes: 16 * TB,
          data_total_bytes: 16 * TB,
          data_available_bytes: 12 * TB,
        }),
      ]
    );
    expect(kinds(events)).toEqual([
      'capacity_changed',
      'disk_changed',
      'node_state',
    ]);
  });
});

describe('ONGOING_KINDS', () => {
  it('matches the copy in the shared schema', () => {
    // The detector runs in Goja and cannot import from `shared`, so the list
    // exists twice. This is what stops the two drifting — the same arrangement
    // the four thresholds above use.
    expect([...ONGOING_KINDS]).toEqual([...SHARED_ONGOING_KINDS]);
  });

  it('exports its flap window so the copy and the query cannot drift', () => {
    expect(FLAP_WINDOW_SEC).toBe(1800);
  });
});

describe('conditionActive', () => {
  it('keeps an outage open while the node is still silent', () => {
    expect(conditionActive('node_state', node({ is_up: false }), false)).toBe(
      true
    );
  });

  it('ends an outage when the node answers again', () => {
    expect(conditionActive('node_state', node(), false)).toBe(false);
  });

  it('cannot tell when the node is not reported at all', () => {
    // Whether that is an outage or a removal is node_removed's question.
    // Answering it here would resolve an outage on a node that has vanished.
    expect(conditionActive('node_state', undefined, false)).toBeNull();
  });

  it('cannot tell when the node failed to record this scrape', () => {
    expect(conditionActive('node_state', undefined, true)).toBeNull();
    expect(conditionActive('node_state', node(), true)).toBeNull();
  });

  it('keeps node_removed open while the node is unlisted', () => {
    expect(conditionActive('node_removed', undefined, false)).toBe(true);
  });

  it('ends node_removed when the node is listed with a role again', () => {
    expect(conditionActive('node_removed', node(), false)).toBe(false);
  });

  it('keeps node_removed open for a node listed with no role', () => {
    expect(
      conditionActive('node_removed', node({ role_capacity_bytes: 0 }), false)
    ).toBe(true);
  });

  it('cannot tell when the layout could not be read', () => {
    // The same gate the diff applies. Without role_ok a capacity of 0 is
    // indistinguishable from an absent field, and closing on it would announce
    // a node had rejoined the layout because the layout failed to load.
    expect(
      conditionActive('node_removed', node({ role_ok: false }), false)
    ).toBeNull();
  });
});

describe('reconcileOngoing', () => {
  const down = node({ is_up: false });
  const opening: Event[] = diffObservations([node()], [down]);

  it('passes a point-in-time event straight through to creates', () => {
    const events: Event[] = diffObservations(
      [node()],
      [node({ node_tags: 'ssd,name:renamed' })]
    );
    const plan: Plan = reconcileOngoing(events, [node()], [], []);
    expect(plan.creates.map((e) => e.kind)).toEqual(['tags_changed']);
    expect(plan.reopens).toEqual([]);
    expect(plan.closes).toEqual([]);
  });

  it('creates the first row for a condition with no history', () => {
    const plan: Plan = reconcileOngoing(opening, [down], [], []);
    expect(plan.creates.map((e) => e.kind)).toEqual(['node_state']);
    expect(plan.reopens).toEqual([]);
  });

  it('drops an opening event when the condition is already open', () => {
    // The noise suppression. Without this a node whose outage was recorded by
    // an earlier scrape would gain a second row the moment any edge recurred.
    const plan: Plan = reconcileOngoing(opening, [down], [openRow()], []);
    expect(plan.creates).toEqual([]);
    expect(plan.reopens).toEqual([]);
    expect(plan.closes).toEqual([]);
  });

  it('closes an open row when the node answers again', () => {
    const plan: Plan = reconcileOngoing([], [node()], [openRow()], []);
    expect(plan.closes).toEqual([{ id: 'row1' }]);
    expect(plan.creates).toEqual([]);
  });

  it('closes with no diff at all, so a recovery survives a gap in the cron', () => {
    // This is the whole reason closing reads current state instead of an edge:
    // after a gap wider than PREV_WINDOW_SEC there is no previous sample, so
    // `diffObservations` is not even called, and an edge-triggered close would
    // leave the outage open for ever.
    const plan: Plan = reconcileOngoing([], [node()], [openRow()], []);
    expect(plan.closes).toHaveLength(1);
  });

  it('leaves a row alone when this scrape cannot tell', () => {
    const plan: Plan = reconcileOngoing([], [], [openRow()], []);
    expect(plan.closes).toEqual([]);
  });

  it('leaves a row alone when its node failed to record', () => {
    const plan: Plan = reconcileOngoing(
      [],
      [node()],
      [openRow()],
      ['a1b2c3d4e5f6']
    );
    expect(plan.closes).toEqual([]);
  });

  it('re-opens a recently closed row instead of appending a new one', () => {
    // The flap rule. `readOpenConditions` has already bounded its query by
    // FLAP_WINDOW_SEC, so any closed row reaching here is inside the window —
    // which is what keeps this function clockless.
    const plan: Plan = reconcileOngoing(
      opening,
      [down],
      [openRow({ ended_at: '2026-08-19 09:15:00.000Z', occurrence_count: 1 })],
      []
    );
    expect(plan.creates).toEqual([]);
    expect(plan.reopens).toEqual([{ id: 'row1', occurrence_count: 2 }]);
  });

  it('re-opens the most recently closed row when several are in the window', () => {
    const plan: Plan = reconcileOngoing(
      opening,
      [down],
      [
        openRow({ id: 'old', ended_at: '2026-08-19 09:00:00.000Z' }),
        openRow({ id: 'new', ended_at: '2026-08-19 09:15:00.000Z' }),
      ],
      []
    );
    expect(plan.reopens.map((r) => r.id)).toEqual(['new']);
  });

  it('counts a row that predates the counter as having opened once already', () => {
    const plan: Plan = reconcileOngoing(
      opening,
      [down],
      [openRow({ ended_at: '2026-08-19 09:15:00.000Z', occurrence_count: 0 })],
      []
    );
    expect(plan.reopens).toEqual([{ id: 'row1', occurrence_count: 2 }]);
  });

  it('does not re-open a row belonging to a different node', () => {
    const plan: Plan = reconcileOngoing(
      opening,
      [down],
      [
        openRow({
          node_id: 'someoneelse',
          ended_at: '2026-08-19 09:15:00.000Z',
        }),
      ],
      []
    );
    expect(plan.reopens).toEqual([]);
    expect(plan.creates.map((e) => e.kind)).toEqual(['node_state']);
  });

  it('does not re-open a row of a different kind', () => {
    const plan: Plan = reconcileOngoing(
      opening,
      [down],
      [openRow({ kind: 'node_removed', ended_at: '2026-08-19 09:15:00.000Z' })],
      []
    );
    expect(plan.reopens).toEqual([]);
    expect(plan.creates.map((e) => e.kind)).toEqual(['node_state']);
  });

  it('closes a node_removed when the node rejoins with a role', () => {
    // The rejoining node has no previous observation, so the diff is silent —
    // there is no "node added" edge to key on. Only current state closes this.
    const plan: Plan = reconcileOngoing(
      [],
      [node()],
      [openRow({ kind: 'node_removed' })],
      []
    );
    expect(plan.closes).toEqual([{ id: 'row1' }]);
  });

  it('resolves one node while opening a condition on another', () => {
    const other = node({ node_id: 'n2' });
    const plan: Plan = reconcileOngoing(
      diffObservations([other], [node({ node_id: 'n2', is_up: false })]),
      [node(), node({ node_id: 'n2', is_up: false })],
      [openRow()],
      []
    );
    expect(plan.closes).toEqual([{ id: 'row1' }]);
    expect(plan.creates.map((e) => e.node_id)).toEqual(['n2']);
  });

  it('ignores an open row of a kind that is not a condition', () => {
    const plan: Plan = reconcileOngoing(
      [],
      [node()],
      [openRow({ kind: 'capacity_changed' })],
      []
    );
    expect(plan.closes).toEqual([]);
  });
});
