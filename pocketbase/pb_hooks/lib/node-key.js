/**
 * The node key, for the PocketBase side of the boundary.
 *
 * A Garage node id is 64 hex characters and its first 16 — the form
 * `garage status` prints — are its key. The key is the only node identifier
 * this app stores or displays; the remaining 48 characters are the credential
 * `POST /next-api/garage/nodes/owners` accepts as proof that you run the
 * machine. Nothing written from here may carry a full id.
 *
 * This is the Goja twin of `nodeKey` in webapp/src/lib/node-label.ts. Goja
 * cannot import TypeScript, so the rule exists twice — and, as with
 * signup-gate.js against signup-mode.ts, a vitest case asserts the two agree
 * rather than trusting that they do.
 *
 * Pure: no Goja globals, no `require`, no clock. Plain `.js`, not `.pb.js`,
 * which PocketBase would load as a hook file in its own right.
 */

/** How many leading characters of a node id make up its key. */
const NODE_KEY_CHARS = 16;

/**
 * A node id reduced to its key. Idempotent — a key in, the same key out — so it
 * is safe to apply at any boundary, including ones that should already be
 * handing over a key. A shorter input is returned whole; test fixtures use ids
 * like `n1`.
 */
function nodeKey(id) {
  return String(id || "")
    .slice(0, NODE_KEY_CHARS)
    .toLowerCase();
}

module.exports = { NODE_KEY_CHARS, nodeKey };
