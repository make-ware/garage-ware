/**
 * What repairs this app offers, and the words it uses for them.
 *
 * **Why `lib/repair/` exists as its own directory**, rather than these living
 * under `lib/storage/`: the same reason `lib/metrics/` and `lib/pricing/` do.
 * `lib/storage/` is the accounting path, and a module of values scraped out of
 * English prose (see ./scrub-status.ts) sitting beside `ledger-math.ts` is an
 * open invitation for a guessed number to typecheck its way into a ledger call
 * site. The dependency is one-way: `lib/repair/` imports nothing from
 * `lib/storage/`, and nothing under `lib/storage/` may import this.
 *
 * Deliberately **not** `server-only`, like `node-label.ts` and
 * `cluster-timeline.ts`: three pages and two route handlers need the same
 * words, and a second hand-kept copy in a component is how a button came to say
 * one thing and the timeline entry it wrote another.
 */

/**
 * One entry per action the UI offers.
 *
 * `launched` / `failed` are the `ClusterEvents.title` strings. They carry **no
 * node name** — the timeline renders `<NodeIdentity>` from `node_id` with names
 * resolved live from the layout, and this repo's rule is that names resolve at
 * display time and are never denormalized onto a row. (The Goja detector does
 * bake labels into titles, but only because it runs on the other side of the
 * workspace with no access to `node-label.ts`. Don't copy it.)
 *
 * Resume and cancel are here though only start and pause were asked for: they
 * are the same four-value `ScrubCommand` enum, and an operator who can pause a
 * scrub but not resume it is stranded.
 */
export const REPAIR_ACTIONS = {
  'scrub-start': {
    button: 'Start scrub',
    launched: 'Scrub started',
    failed: 'Scrub failed to start',
  },
  'scrub-pause': {
    button: 'Pause scrub',
    launched: 'Scrub paused',
    failed: 'Scrub failed to pause',
  },
  'scrub-resume': {
    button: 'Resume scrub',
    launched: 'Scrub resumed',
    failed: 'Scrub failed to resume',
  },
  'scrub-cancel': {
    button: 'Cancel scrub',
    launched: 'Scrub cancelled',
    failed: 'Scrub failed to cancel',
  },
  blocks: {
    button: 'Repair blocks',
    launched: 'Block repair started',
    failed: 'Block repair failed to start',
  },
  rebalance: {
    button: 'Rebalance',
    launched: 'Rebalance started',
    failed: 'Rebalance failed to start',
  },
} as const;

export type RepairAction = keyof typeof REPAIR_ACTIONS;

/** For the route handler's `z.enum`, which needs a tuple rather than keys. */
export const REPAIR_ACTION_IDS = Object.keys(REPAIR_ACTIONS) as [
  RepairAction,
  ...RepairAction[],
];

export const SCRUB_ACTIONS = [
  'scrub-start',
  'scrub-pause',
  'scrub-resume',
  'scrub-cancel',
] as const satisfies readonly RepairAction[];
