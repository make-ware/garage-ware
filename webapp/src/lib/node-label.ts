/**
 * How a Garage node is identified — its name, or its **node key**.
 *
 * Deliberately **not** `server-only` (like `lib/storage/units.ts`,
 * `ledger-math.ts` and `object-cap.ts`): the label has to be computed in the
 * admin console, the dashboard and the cluster map, all client-side, and a
 * second hand-rolled copy in a component is exactly how the app ended up with
 * six different ways to name a node — three `nodeLabelFor`s, two inline copies,
 * truncations at 8 and 12 characters, and a hostname fallback that rendered
 * blank on one page and the id on another.
 *
 * ## The key is the identifier; the full id is a credential
 *
 * A Garage node id is 64 hex characters. Its **first 16** — the form
 * `garage status` prints in its `ID` column — are the node key, and the key is
 * the only node identifier this app uses: it is what every PocketBase row
 * stores, what every API payload carries, what goes in a URL parameter or a
 * `<Select>` value, and what renders on screen.
 *
 * The remaining 48 characters are a secret. Possession of a full id is what
 * `POST /next-api/garage/nodes/owners` accepts as proof that you run the
 * machine, so a full id never leaves the server: no route handler emits one and
 * no collection stores one. It enters the app only when a claimer types one in,
 * and leaves it only in a request to Garage — resolved from the live layout by
 * `lib/garage/node-resolve.ts`, because Garage's own `?node=` parameter is
 * documented to take a full id and nothing else.
 *
 * Truncating to a prefix rather than hashing to a surrogate is deliberate. It
 * matches the CLI, so an operator recognises the string, and it costs nothing:
 * 192 bits of the id remain unknown.
 *
 * **Garage has no node `name` field.** The layout role's `tags: string[]` is
 * the only operator-settable label on a node, so a name is a tag prefixed
 * `name:` — `["ssd", "name:vault-01", "rack4"]` names the node `vault-01`.
 * Nothing in this app writes tags; the name is set through Garage itself.
 *
 * Names are resolved at **display time** by looking a key up against the live
 * layout, never denormalized onto a row. StorageClaims and StorageClaimAudit
 * already snapshot `node_hostname` at write time and never refresh it, which is
 * precisely how a node came to show two different labels on two different
 * pages. A node that has left the layout resolves to no name and falls back to
 * its key — which is the honest answer.
 */

/** The tag prefix that marks a node's name. Compared case-insensitively. */
export const NODE_NAME_TAG_PREFIX = 'name:';

/**
 * How many leading characters of a node id make up its key.
 *
 * 16, because that is what the Garage CLI prints and therefore what an operator
 * reading `garage status` will recognise. Exported so copy and tests cannot
 * drift from it.
 */
export const NODE_KEY_CHARS = 16;

/**
 * The public identifier of a node: the first {@link NODE_KEY_CHARS} characters
 * of its Garage node id.
 *
 * A documentation alias, not a branded type — every payload field and PocketBase
 * column that once held a node id now holds one of these, and `id: NodeKey` says
 * so at the point it matters without a repo-wide rename.
 */
export type NodeKey = string;

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
 * A node id reduced to its key: the one identifying form in the app.
 *
 * **Idempotent** — a key in, the same key out — which is what makes it safe as
 * a defensive normalizer at any boundary, including ones that should already be
 * handing over a key. Returned whole when it is already short enough; every
 * test fixture in this repo uses ids like `node-a`, so that path does get
 * exercised.
 *
 * There is no ellipsis, unlike the 8-character form this replaced. The key has
 * to be a valid prefix of the id it came from: it is matched against the layout
 * server-side to recover the full id, and `a1b2c3d4…` is not a prefix of
 * anything.
 */
export function nodeKey(id: string): NodeKey {
  return id.slice(0, NODE_KEY_CHARS).toLowerCase();
}

/**
 * Is this a full 64-character Garage node id?
 *
 * The claim route's admission test, and the reason it is strict: a node key is
 * public and a full id is the credential, so accepting a prefix there would
 * hand ownership to anyone who can read a page. Lowercase only — callers
 * normalise first, so that a mixed-case paste fails the length check rather
 * than the character class.
 */
export function isFullNodeId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** Is this exactly a node key — 16 lowercase hex characters? */
export function isNodeKey(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value);
}

/** A node's display label: its name, or its key. */
export function nodeLabel(name: string | null | undefined, id: string): string {
  return name || nodeKey(id);
}

/**
 * Node key → name, for the views that label historical rows carrying nothing
 * but a `node_id` (the claims table, the audit ledger) and so have to resolve
 * against the layout they hold.
 *
 * **Keyed by `nodeKey(role.id)`, not `role.id`.** The roles come straight from
 * Garage and carry full ids; every row looked up against this map carries a
 * key. Normalising here is what keeps every comparison in the app key-to-key.
 *
 * Typed structurally so this module never imports from `lib/garage/*`, which is
 * `server-only`. Unnamed nodes are absent rather than mapped to `''`, which
 * makes `map.get(key) ?? null` the natural call.
 */
export function buildNodeNameMap(
  roles?: readonly { id: string; tags?: readonly string[] }[] | null
): Map<NodeKey, string> {
  const names = new Map<NodeKey, string>();
  for (const role of roles ?? []) {
    const { name } = parseNodeTags(role.tags);
    if (name) names.set(nodeKey(role.id), name);
  }
  return names;
}
