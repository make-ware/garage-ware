/**
 * How a Garage node is identified in the UI — its name, or a truncated node id.
 *
 * Deliberately **not** `server-only` (like `lib/storage/units.ts`,
 * `ledger-math.ts` and `object-cap.ts`): the label has to be computed in the
 * admin console, the dashboard and the cluster map, all client-side, and a
 * second hand-rolled copy in a component is exactly how the app ended up with
 * six different ways to name a node — three `nodeLabelFor`s, two inline copies,
 * truncations at 8 and 12 characters, and a hostname fallback that rendered
 * blank on one page and the id on another.
 *
 * **Garage has no node `name` field.** The layout role's `tags: string[]` is
 * the only operator-settable label on a node, so a name is a tag prefixed
 * `name:` — `["ssd", "name:vault-01", "rack4"]` names the node `vault-01`.
 * Nothing in this app writes tags; the name is set through Garage itself.
 *
 * Names are resolved at **display time** by looking a `node_id` up against the
 * live layout, never denormalized onto a row. StorageClaims and
 * StorageClaimAudit already snapshot `node_hostname` at write time and never
 * refresh it, which is precisely how a node came to show two different labels
 * on two different pages. A node that has left the layout resolves to no name
 * and falls back to its short id — which is the honest answer.
 */

/** The tag prefix that marks a node's name. Compared case-insensitively. */
export const NODE_NAME_TAG_PREFIX = 'name:';

/** How many leading characters of a node id a short id keeps. */
const SHORT_ID_CHARS = 8;

export interface ParsedNodeTags {
  /** The node's name, or `null` when no tag carries one. */
  name: string | null;
  /** The remaining tags, with the one that supplied the name removed. */
  rest: string[];
}

/**
 * Split a node's tags into its name and everything else.
 *
 * One function rather than a `nodeNameFromTags` plus a `withoutNameTag`,
 * because the two must agree on exactly which tag was consumed — otherwise a
 * node's name renders twice, once as its label and once as a badge beside it.
 *
 * A `name:` tag with an empty or whitespace-only value is **skipped, not
 * honoured**: a stray `name:` sorting ahead of the real one would otherwise
 * blank the node. A second, genuine `name:` tag is left in `rest` on purpose —
 * that it is being ignored is worth seeing.
 */
export function parseNodeTags(tags?: readonly string[] | null): ParsedNodeTags {
  if (!tags || tags.length === 0) return { name: null, rest: [] };

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (!tag.toLowerCase().startsWith(NODE_NAME_TAG_PREFIX)) continue;
    // `name: sofia` is what an operator actually types.
    const value = tag.slice(NODE_NAME_TAG_PREFIX.length).trim();
    if (!value) continue;
    return { name: value, rest: tags.filter((_, j) => j !== i) };
  }

  return { name: null, rest: [...tags] };
}

/**
 * A node id shortened for display: the one truncated form in the app.
 *
 * Returned whole when it is already short enough — an ellipsis has to mean
 * something was cut. Garage ids are 64 hex characters, but every test fixture
 * in this repo uses ids like `node-a`, so this path does get exercised.
 */
export function shortNodeId(id: string): string {
  return id.length <= SHORT_ID_CHARS ? id : `${id.slice(0, SHORT_ID_CHARS)}…`;
}

/** A node's display label: its name, or the short form of its id. */
export function nodeLabel(name: string | null | undefined, id: string): string {
  return name || shortNodeId(id);
}

/**
 * Node id → name, for the views that label historical rows carrying nothing
 * but a `node_id` (the claims table, the audit ledger) and so have to resolve
 * against the layout they hold.
 *
 * Typed structurally so this module never imports from `lib/garage/*`, which is
 * `server-only`. Unnamed nodes are absent rather than mapped to `''`, which
 * makes `map.get(id) ?? null` the natural call.
 */
export function buildNodeNameMap(
  roles?: readonly { id: string; tags?: readonly string[] }[] | null
): Map<string, string> {
  const names = new Map<string, string>();
  for (const role of roles ?? []) {
    const { name } = parseNodeTags(role.tags);
    if (name) names.set(role.id, name);
  }
  return names;
}
