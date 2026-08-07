/// <reference path="../pb_data/types.d.ts" />
//
// Immutable audit trail for the StorageClaims ledger.
//
// Two things here are deliberate and worth keeping if this file is ever
// regenerated:
//
//  1. All three write rules are null. The rows are written by the hooks in
//     pb_hooks/main.pb.js through the Go/JSVM layer (`e.app.save`), which
//     bypasses collection rules entirely — so locking the API surface costs
//     nothing and makes the log append-only from the outside.
//
//  2. `user_id`, `claim_id` and `actor_id` are plain text, not relations.
//     StorageClaims.user cascades from Users, so deleting a user erases their
//     claims; a relation here would erase the audit trail with them, at
//     exactly the moment it is worth having. `claim_id` is expected to dangle
//     after the source entry is deleted — that is the point.
//
migrate((app) => {
  const collection = new Collection({
    "id": "pb_n84agjo955ign2e",
    "name": "StorageClaimAudit",
    "type": "base",
    "system": false,
    "listRule": "@collection.Admins.user ?= @request.auth.id",
    "viewRule": "@collection.Admins.user ?= @request.auth.id",
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
      "name": "action",
      "id": "selectjd669bdqtr",
      "type": "select",
      "required": true,
      "maxSelect": 1,
      "values": ["create", "update", "delete"],
    },
    {
      "name": "claim_id",
      "id": "texte5atcvphx6",
      "type": "text",
      "required": false,
      "max": 32,
    },
    {
      "name": "user_id",
      "id": "text6n97y7o3it",
      "type": "text",
      "required": true,
      "min": 1,
      "max": 32,
    },
    {
      "name": "user_email",
      "id": "texttzbxvgpy63",
      "type": "text",
      "required": false,
      "max": 255,
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
      "name": "previous_gb",
      "id": "numbersbhajhbq30",
      "type": "number",
      "required": false,
    },
    {
      "name": "new_gb",
      "id": "numberucewpx6wah",
      "type": "number",
      "required": false,
    },
    {
      "name": "delta_gb",
      "id": "number3gppvqh98g",
      "type": "number",
      "required": false,
    },
    {
      "name": "note",
      "id": "textva304bmfya",
      "type": "text",
      "required": false,
      "max": 500,
    },
    {
      "name": "actor_id",
      "id": "textcdgwcehlof",
      "type": "text",
      "required": false,
      "max": 32,
    },
    {
      "name": "actor_email",
      "id": "texttptohnxyrw",
      "type": "text",
      "required": false,
      "max": 255,
    },
    {
      "name": "actor_type",
      "id": "select7d4h04uxeo",
      "type": "select",
      "required": false,
      "maxSelect": 1,
      "values": ["user", "superuser", "system"],
    },
    {
      "name": "source",
      "id": "select315eg4aevr",
      "type": "select",
      "required": false,
      "maxSelect": 1,
      "values": ["api", "cascade"],
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
    "CREATE INDEX `idx_claimaudit_user` ON `StorageClaimAudit` (`user_id`)",
    "CREATE INDEX `idx_claimaudit_node` ON `StorageClaimAudit` (`node_id`)",
    "CREATE INDEX `idx_claimaudit_claim` ON `StorageClaimAudit` (`claim_id`)",
    "CREATE INDEX `idx_claimaudit_created` ON `StorageClaimAudit` (`created`)",
  ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_n84agjo955ign2e") // StorageClaimAudit;
  return app.delete(collection);
});
