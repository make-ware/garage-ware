import { nodeKey, parseNodeTags, type NodeKey } from '@/lib/node-label';

/**
 * What is staged on the cluster layout, and what an operator has to run to
 * commit it.
 *
 * Pure, clockless, and **not** `server-only`: the route computes the conflict
 * fingerprint from a live Garage read and the page computes it from the payload
 * it was served, and the two must agree exactly — one function, called on both
 * sides, is the only arrangement in which they cannot drift.
 *
 * Like `layout-sim.ts` and `layout-draft.ts` this module is **bytes only, with
 * no `gb` in any identifier**. Garage's layout capacities are decimal bytes and
 * the storage ledger is binary GB; a value that crossed between them would
 * typecheck silently, so the hazard is kept visible at the call site. See
 * `layout-sim-boundary.test.ts` for the full account.
 */

/**
 * One staged change, in the shape both sides hold it: `id` is a **node key** in
 * the browser and a full node id on the server, and `nodeKey()` normalises
 * either. Fields beyond these four are dropped by the route's projection, so
 * this is the whole of what a staged change means to this app.
 */
export interface StagedRoleChangeLike {
  id: string;
  remove?: boolean;
  zone?: string;
  capacity?: number | null;
  tags?: readonly string[];
}

/** A live layout role, structurally typed so this module never imports `lib/garage`. */
export interface StagingRole {
  id: string;
  zone: string;
  capacity?: number | null;
  tags?: readonly string[];
}

export type StagedChangeKind = 'assign' | 'remove' | 'unrecognised';

export interface StagedChangeRow {
  nodeKey: NodeKey;
  /** From the node's `name:` tag in the **live** layout; null for a new node. */
  name: string | null;
  kind: StagedChangeKind;
  /** True when the node currently has no role — this change would add one. */
  isNew: boolean;
  fromZone: string | null;
  toZone: string | null;
  fromCapacityBytes: number | null;
  toCapacityBytes: number | null;
  fromTags: string[];
  toTags: string[];
}

/**
 * Join each staged change against the role it would replace.
 *
 * A change is `remove` when it says so, `assign` when it carries a zone, and
 * **`unrecognised` otherwise** — that third state is the point. `garage layout
 * apply` commits every staged change, not only the ones this app understands,
 * so a shape from a newer Garage (or from a CLI feature this app has no UI for)
 * has to appear in the table as "something is staged on this node" rather than
 * be dropped from it. Dropping it would report an empty staging area to an
 * operator about to apply one.
 *
 * `capacity: null` on an assign is a **gateway**, not "unknown": that is
 * Garage's own encoding, documented on `UpdateClusterLayout`.
 */
export function describeStagedChanges(
  roles: readonly StagingRole[],
  staged: readonly StagedRoleChangeLike[]
): StagedChangeRow[] {
  const byKey = new Map(roles.map((role) => [nodeKey(role.id), role]));

  return staged.map((change) => {
    const key = nodeKey(change.id);
    const role = byKey.get(key);
    const fromTags = role?.tags ? [...role.tags] : [];
    const base = {
      nodeKey: key,
      name: parseNodeTags(role?.tags).name,
      isNew: role === undefined,
      fromZone: role?.zone ?? null,
      fromCapacityBytes: role?.capacity ?? null,
      fromTags,
    };

    if (change.remove === true) {
      return {
        ...base,
        kind: 'remove' as const,
        toZone: null,
        toCapacityBytes: null,
        toTags: [],
      };
    }
    if (typeof change.zone === 'string') {
      return {
        ...base,
        kind: 'assign' as const,
        toZone: change.zone,
        toCapacityBytes: change.capacity ?? null,
        toTags: change.tags ? [...change.tags] : [],
      };
    }
    return {
      ...base,
      kind: 'unrecognised' as const,
      toZone: null,
      toCapacityBytes: null,
      toTags: [],
    };
  });
}

/**
 * A deterministic summary of the staging area — the app's optimistic-concurrency
 * token.
 *
 * **Garage offers none of its own.** `UpdateClusterLayout` takes no version and
 * no CAS parameter: it merges what you send into whatever is already staged and
 * answers 200. Two admins each staging a different capacity for the same node
 * therefore produce one silently merged staging area, and the second one's
 * `garage layout apply` commits both. So the check is built here — the client
 * echoes back the version and this fingerprint, the route recomputes both from
 * a **live** read, and a mismatch is a 409 that is never retried.
 *
 * Sorted by node key so ordering from Garage cannot flip the value, and
 * computed over exactly the four projected fields, so the server (holding full
 * ids and Garage's own array) and the browser (holding the key-reduced
 * projection) arrive at the same string. Two *differently* unrecognised changes
 * on one node hash the same; that is deliberate and harmless — the row is
 * already telling the operator to go read `garage layout show`.
 */
export function stagedFingerprint(
  staged: readonly StagedRoleChangeLike[]
): string {
  return staged
    .map((change) => {
      const key = nodeKey(change.id);
      if (change.remove === true) return `${key}:remove`;
      if (typeof change.zone === 'string') {
        const capacity =
          change.capacity === null || change.capacity === undefined
            ? 'gateway'
            : String(change.capacity);
        const tags = [...(change.tags ?? [])].sort().join(',');
        return `${key}:assign:${change.zone}:${capacity}:${tags}`;
      }
      return `${key}:unrecognised`;
    })
    .sort()
    .join('|');
}

/**
 * The version number `garage layout apply` must be given: the current one plus
 * one.
 *
 * Applying the staging area produces the *next* version, and Garage requires
 * the operator to name it — that argument is the confirmation that they are
 * applying the change they just looked at, and it is what makes a second,
 * duplicate apply fail instead of bumping the version again.
 */
export function nextApplyVersion(version: number): number {
  return version + 1;
}

/**
 * The two commands, in the order they must be run. One implementation, so the
 * panel and its test cannot disagree about the version number.
 *
 * `garage layout revert` is **not** here on purpose. It is the manual escape
 * hatch, it is named in the panel's prose, and keeping it out of the copyable
 * block is what stops it being pasted by reflex — it is not an undo, it clears
 * the staging area by incrementing the layout version.
 */
export function applyCommands(version: number): string[] {
  return [
    'garage layout show',
    `garage layout apply --version ${nextApplyVersion(version)}`,
  ];
}
