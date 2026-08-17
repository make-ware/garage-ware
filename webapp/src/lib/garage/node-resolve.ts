import 'server-only';
import type { ClusterLayout } from './schemas';
import { HttpError } from '@/lib/auth/server';
import {
  type NodeKey,
  isFullNodeId,
  nodeKey,
  parseNodeTags,
} from '@/lib/node-label';

/**
 * Turning a node key back into the full node id Garage needs.
 *
 * The app identifies a node by its key — 16 hex characters — everywhere: in
 * PocketBase rows, in payloads, in URL parameters, on screen. Garage does not.
 * Its `?node=` parameter is documented, on all twelve on-node operations, as
 * "Node ID to query, or `*` for all nodes, or `self` for the node responding to
 * the request", with `required: true`, no `pattern`, and no partial-match
 * variant. Where Garage *does* take a partial identifier it says so on a
 * separate parameter — `GetKeyInfo` has `search`, "Partial key ID or name to
 * search for" — and it does not do that for `node`.
 *
 * That silence is why this module exists rather than the app simply sending the
 * key. `lib/garage/repair.ts` puts the caller's string on the wire and then
 * looks the **same string** back up as a key of the multi-node response
 * envelope, and deliberately refuses to fuzzy-match if the two disagree. Send a
 * key that Garage resolves by prefix but answers by full id and every repair
 * reads as a failure that actually ran.
 *
 * So: keys stop at this boundary. A handler resolves, calls Garage with the
 * full id, and re-keys anything it hands back.
 *
 * The layout passed in must be a **live** read. Every caller is performing an
 * action rather than rendering, and `lib/garage/cached.ts` is built to serve a
 * stale layout straight through an outage.
 */

interface LayoutRole {
  id: string;
  tags?: readonly string[];
}

function rolesOf(layout: ClusterLayout): readonly LayoutRole[] {
  return layout.roles ?? [];
}

/**
 * The full node id whose key is `key`.
 *
 * Two nodes sharing a 16-character prefix is a 409, never a silent first match.
 * It cannot happen with real Garage ids — it needs a 64-bit collision — so if
 * it ever does, something is wrong in a way that picking one of them would
 * bury. The Garage CLI treats an ambiguous prefix the same way.
 *
 * Accepts a full id too, since `nodeKey` is idempotent; a caller holding one
 * does not have to know which it has.
 */
export function resolveNodeKey(layout: ClusterLayout, key: string): string {
  const wanted = nodeKey(key);
  const matches = rolesOf(layout).filter((r) => nodeKey(r.id) === wanted);

  if (matches.length === 0) {
    throw new HttpError(404, 'No such node in the cluster layout');
  }
  if (matches.length > 1) {
    throw new HttpError(
      409,
      `Node key ${wanted} is ambiguous — ${matches.length} nodes share it`
    );
  }
  return matches[0].id;
}

/**
 * The full node id for anything an operator might reasonably type: a full id, a
 * node key, or a node **name** (the `name:` tag).
 *
 * CLI parity, for surfaces that take a typed identifier rather than a value
 * picked from a list. Resolution order is id, then key, then name — most
 * specific first — and a name matching more than one node is a 409 for the same
 * reason an ambiguous key is.
 *
 * Note what is *not* accepted: a hostname. It has never been one of this app's
 * two identifier forms, and the layout does not carry one anyway.
 */
export function resolveNodeIdentifier(
  layout: ClusterLayout,
  input: string
): string {
  const value = input.trim();
  if (!value) throw new HttpError(400, 'A node identifier is required');

  const lowered = value.toLowerCase();
  if (isFullNodeId(lowered)) {
    const exact = rolesOf(layout).find((r) => r.id.toLowerCase() === lowered);
    if (exact) return exact.id;
    throw new HttpError(404, 'No such node in the cluster layout');
  }

  const byKey = rolesOf(layout).filter((r) => nodeKey(r.id) === lowered);
  if (byKey.length === 1) return byKey[0].id;
  if (byKey.length > 1) {
    throw new HttpError(
      409,
      `Node key ${lowered} is ambiguous — ${byKey.length} nodes share it`
    );
  }

  // Names are case-sensitive: they are operator-set tag values, and two nodes
  // named `vault-01` and `Vault-01` are two different labels, not one.
  const byName = rolesOf(layout).filter(
    (r) => parseNodeTags(r.tags).name === value
  );
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) {
    throw new HttpError(
      409,
      `Node name ${value} is ambiguous — ${byName.length} nodes carry it`
    );
  }

  throw new HttpError(404, 'No such node in the cluster layout');
}

/** Every node key currently carrying a role, for membership checks. */
export function layoutNodeKeys(layout: ClusterLayout): Set<NodeKey> {
  return new Set(rolesOf(layout).map((r) => nodeKey(r.id)));
}
