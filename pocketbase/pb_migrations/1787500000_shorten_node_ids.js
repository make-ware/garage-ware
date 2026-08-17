/// <reference path="../pb_data/types.d.ts" />
//
// Truncate every stored `node_id` to its 16-character node key.
//
// A Garage node id is 64 hex characters. Its first 16 — the form `garage
// status` prints in its ID column — become the app's only node identifier, and
// the remaining 48 become a secret: `POST /next-api/garage/nodes/owners`
// accepts a full id as proof that the claimer runs the machine. That was
// previously an ACCEPTED GAP in three places, because `NodeMetrics` is readable
// by any signed-in user (listRule `@request.auth.id != ''`) and
// `GET /next-api/garage/cluster/nodes` emitted `id` untruncated. See the
// node-identity section of CLAUDE.md.
//
// This migration is what makes the boundary structural rather than reviewed:
// with no full id anywhere in PocketBase, no collection rule and no route
// projection can leak one by omission. The full id lives only in Garage, and is
// resolved back from a key on demand by webapp/src/lib/garage/node-resolve.ts.
//
// NO SCHEMA OR RULE CHANGES — this is data only. In particular `NodeMetrics`
// keeps its open listRule, which is why the cluster map and /dashboard/metrics
// go on reading PocketBase directly instead of needing a projecting handler.
//
// The two UNIQUE indexes over node_id survive: `idx_nodeowners_node` and
// StorageNodeBalances' (user, node_id). Two rows can only collide if two nodes
// share a 64-bit id prefix.
//
// Ships in the same image as the code change, necessarily. Truncated rows read
// by pre-change code would fail to join against a layout keyed by full ids.
//
// Hand-written rather than generated: `yarn db:migrate` cannot run against this
// repo's migration history at all — see 1786200000_updated_Buckets.js.
const NODE_ID_COLLECTIONS = [
  "NodeMetrics",
  "ClusterEvents",
  "StorageClaims",
  "StorageClaimAudit",
  "StorageNodeBalances",
  "NodeOwners",
];

migrate((app) => {
  for (const name of NODE_ID_COLLECTIONS) {
    app
      .db()
      .newQuery(
        "UPDATE `" +
          name +
          "` SET node_id = substr(node_id, 1, 16) WHERE length(node_id) > 16"
      )
      .execute();
  }
}, (app) => {
  // Deliberately a no-op, and it cannot be anything else: truncation discarded
  // 48 characters per row and nothing in this database ever held them. For a
  // node still carrying a role the full id is recoverable from Garage's live
  // layout; for one that has left, it is gone for good. Reverting the code
  // without reverting the data is safe — `nodeKey` is idempotent, so a key
  // passed through it again is unchanged — which is the reason this can afford
  // to do nothing. Same posture as 1785361304_updated_StorageClaims.js, which
  // records in its own `down` why the revert cannot succeed against real data.
});
