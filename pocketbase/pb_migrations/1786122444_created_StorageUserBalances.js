/// <reference path="../pb_data/types.d.ts" />
//
// The node-agnostic half of a user's position: transfers in/out and how much
// their buckets reserve. Companion to StorageNodeBalances; same cache caveats,
// same onBootstrap backfill.
//
// `claims_gb` here is the UNFILTERED sum across all nodes and is not the user's
// granted storage — a claim on a node that has left the layout backs nothing.
// The granted figure comes from StorageNodeBalances filtered by the live
// layout, which only the webapp can do. This column exists to detect drift.
//
migrate((app) => {
  const collection = new Collection({
    "id": "pb_u0lye0hpvl3q7wi",
    "name": "StorageUserBalances",
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
      "name": "claims_gb",
      "id": "number00xsmesd2i",
      "type": "number",
      "required": false,
    },
    {
      "name": "sent_gb",
      "id": "number8zq8ls74mj",
      "type": "number",
      "required": false,
      "min": 0,
    },
    {
      "name": "received_gb",
      "id": "numberovrb0vh0i0",
      "type": "number",
      "required": false,
      "min": 0,
    },
    {
      "name": "allocated_gb",
      "id": "number4aw6p6z8gf",
      "type": "number",
      "required": false,
      "min": 0,
    },
    {
      "name": "recomputed_at",
      "id": "datejm40bb2pho",
      "type": "date",
      "required": false,
    },
    {
      "name": "last_drift_gb",
      "id": "number5zwhgv3my8",
      "type": "number",
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
    "CREATE UNIQUE INDEX `idx_userbalance_user` ON `StorageUserBalances` (`user`)",
  ],
  });

  app.save(collection);

  // Populate both balance collections from the existing ledgers, in the same
  // migration that introduces them.
  //
  // This has to happen here rather than in an onBootstrap hook: on the boot
  // that upgrades an existing deployment, migrations run *after* bootstrap
  // fires, so a hook-based backfill finds no collections and does nothing —
  // leaving the cache empty on exactly the installation that has data to
  // backfill. The read path would then report every user as having zero
  // granted storage. Doing it here keeps the data and the schema atomic.
  //
  // Runs after StorageNodeBalances (1786122443) so both tables exist. Reuses
  // the same rebuildAll the cron and the admin rebuild route call, so there is
  // one definition of what these numbers mean.
  const { rebuildAll } = require(`${__hooks}/lib/storage-balance.js`);
  const result = rebuildAll(app);
  console.log(
    `[storage-balance] migration backfill: ${result.users} user(s), ${result.nodes} node balance(s)`
  );
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_u0lye0hpvl3q7wi") // StorageUserBalances;
  return app.delete(collection);
});
