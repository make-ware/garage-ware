/// <reference path="../pb_data/types.d.ts" />
//
// NodeOwners — ownership of one Garage cluster node by one PocketBase user.
//
// A user who contributed hardware claims the node by supplying its full Garage
// node id, and may thereafter append StorageClaims entries sourced from it, to
// themselves or to any other user. Ownership decides *who may append a row*,
// never *how much*: an owner's write passes through exactly the same
// assertClaimDeltaAllowed invariants an admin's does.
//
// THE UNIQUE INDEX ON node_id IS THE CONCURRENCY CONTROL, not decoration.
// webapp/src/lib/setup/claim.ts — this repo's other claim-with-a-secret flow —
// could only narrow its read-then-write race with a process-global promise
// mutex, and says in its own comments that this does not span replicas. Here
// the database can express "one owner per node" directly, so the claim route
// has no mutex and no backoff: two simultaneous claims mean one insert and one
// uniqueness violation, which the route maps to 409. Do not "optimise" this
// into a pre-flight existence check.
//
// node_id is plain text, not a relation: nodes are Garage entities with no PB
// counterpart. Same reasoning as StorageClaims, StorageClaimAudit and
// ClusterEvents.
//
// There is deliberately NO node_hostname / node_zone snapshot, unlike
// StorageClaims. Node names resolve at display time from the live layout (see
// webapp/src/lib/node-label.ts); the frozen snapshots on StorageClaims are
// precisely how one node came to render two different labels on two pages.
//
// Reads are self-or-admin, which is load-bearing: it is what lets
// assertNodeOwner resolve ownership through the *caller's own* client with no
// superuser auth, because a lookup by node id returns the row iff the caller
// owns it. All three write rules are null — claiming has to check the live
// cluster layout first, which a collection rule cannot do, so the route
// handlers write as a superuser and locking writes costs nothing.
//
// Hand-written rather than generated: `yarn db:migrate` cannot run against this
// repo's migration history at all (see 1786200000_updated_Buckets.js). Mirrors
// shared/src/schema/node-owner.ts — keep the two in sync by hand.
migrate((app) => {
  const collection = new Collection({
    "id": "pb_nodeowner4m2x81",
    "name": "NodeOwners",
    "type": "base",
    "system": false,
    "listRule": "user = @request.auth.id || @collection.Admins.user ?= @request.auth.id",
    "viewRule": "user = @request.auth.id || @collection.Admins.user ?= @request.auth.id",
    "createRule": null,
    "updateRule": null,
    "deleteRule": null,
    "fields": [
      {
        "name": "id",
        "id": "text3208210256",
        "type": "text",
        "required": true,
        "autogeneratePattern": "[a-z0-9]{15}",
        "hidden": false,
        "max": 15,
        "min": 15,
        "pattern": "^[a-z0-9]+$",
        "presentable": false,
        "primaryKey": true,
        "system": true,
      },
      {
        "name": "user",
        "id": "relnodeownusr1",
        "type": "relation",
        "required": true,
        "collectionId": "_pb_users_auth_",
        "maxSelect": 1,
        "minSelect": 0,
        "cascadeDelete": true,
        "displayFields": null,
      },
      { "name": "node_id", "id": "textnodeownid1", "type": "text", "required": true, "min": 1, "max": 128 },
      { "name": "note", "id": "textnodeownnt1", "type": "text", "required": false, "max": 500 },
      {
        "name": "created",
        "id": "autodate2990389176",
        "type": "autodate",
        "required": false,
        "hidden": false,
        "onCreate": true,
        "onUpdate": false,
        "presentable": false,
        "system": true,
      },
      {
        "name": "updated",
        "id": "autodate3332085495",
        "type": "autodate",
        "required": false,
        "hidden": false,
        "onCreate": true,
        "onUpdate": true,
        "presentable": false,
        "system": true,
      },
    ],
    "indexes": [
      // One owner per node, enforced by the database. See the header.
      "CREATE UNIQUE INDEX `idx_nodeowners_node` ON `NodeOwners` (`node_id`)",
      "CREATE INDEX `idx_nodeowners_user` ON `NodeOwners` (`user`)",
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_nodeowner4m2x81") // NodeOwners;
  return app.delete(collection);
});
