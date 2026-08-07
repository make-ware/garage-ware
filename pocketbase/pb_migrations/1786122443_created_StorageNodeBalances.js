/// <reference path="../pb_data/types.d.ts" />
//
// Per-(user, node) roll-up of the StorageClaims ledger. A cache, maintained by
// the hooks in pb_hooks/main.pb.js.
//
// Note this collection is created EMPTY. It is backfilled from the ledger by
// the *sibling migration* 1786122444_created_StorageUserBalances.js, which runs
// straight after this one and calls rebuildAll once both tables exist; the
// nightly cron then keeps it honest. Deliberately not an onBootstrap hook —
// migrations run after bootstrap fires, so such a hook would find no
// collections on exactly the upgrade boot that has data to backfill (see the
// note in pb_hooks/main.pb.js).
//
// Reads switch to this table, so a missing backfill reads as everyone having
// zero granted storage. To verify it ran, look for the
// "[storage-balance] migration backfill: N user(s), M node balance(s)" line in
// the startup log — not for anything at bootstrap.
//
// Two choices here are deliberately the opposite of StorageClaimAudit:
//   - `user` cascades from Users. This is derived data; when the user goes,
//     their claims cascade and the roll-up must go too.
//   - The (user, node_id) index IS unique, where StorageClaims' is not. That
//     one stores entries; this one stores the sum, so the database enforcing
//     one row per pair turns a hook bug into a loud error instead of a
//     silently duplicated balance.
//
migrate((app) => {
  const collection = new Collection({
    "id": "pb_rngymjw5jka2okn",
    "name": "StorageNodeBalances",
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
      "id": "relatione6jbx1dz77",
      "type": "relation",
      "required": true,
      "collectionId": "_pb_users_auth_",
      "maxSelect": 1,
      "minSelect": 0,
      "cascadeDelete": true,
    },
    {
      "name": "node_id",
      "id": "texta8btjpu7d5",
      "type": "text",
      "required": true,
      "min": 1,
      "max": 128,
    },
    {
      "name": "claimed_gb",
      "id": "numberbp9lftiek5",
      "type": "number",
      "required": false,
    },
    {
      "name": "entry_count",
      "id": "numberfv98phd47j",
      "type": "number",
      "required": false,
      "min": 0,
      "max": 9007199254740991,
      "onlyInt": true,
    },
    {
      "name": "node_hostname",
      "id": "textbviluxdlko",
      "type": "text",
      "required": false,
      "max": 255,
    },
    {
      "name": "node_zone",
      "id": "texth9fgffbjy0",
      "type": "text",
      "required": false,
      "max": 64,
    },
    {
      "name": "recomputed_at",
      "id": "datejm40bb2pho",
      "type": "date",
      "required": false,
    },
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
    "CREATE UNIQUE INDEX `idx_nodebalance_user_node` ON `StorageNodeBalances` (`user`, `node_id`)",
    "CREATE INDEX `idx_nodebalance_node` ON `StorageNodeBalances` (`node_id`)",
  ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_rngymjw5jka2okn") // StorageNodeBalances;
  return app.delete(collection);
});
