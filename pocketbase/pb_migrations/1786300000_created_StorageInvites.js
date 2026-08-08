/// <reference path="../pb_data/types.d.ts" />
//
// Creates `StorageInvites`: storage promised to an email address that has no
// account yet. A StorageTransfer needs two Users rows, so until now there was
// no way to hand capacity to someone who has not signed up; the claim endpoint
// (`POST /next-api/garage/invites/claim`) turns a pending invite into a real
// transfer once that address owns an account.
//
// `to_email` is a plain text column, not a relation — the whole point is that
// the row outlives the absence of the user it names. It is stored lowercased so
// the claim lookup stays a plain equality match (PocketBase filters have no
// case-insensitive comparison).
//
// `updateRule` is null: `status` only ever moves under the claim endpoint,
// which authenticates as a PB superuser and so bypasses collection rules.
// Cancelling an invite is a delete, mirroring how a transfer is "returned".
//
// Hand-written rather than generated, for the reason documented in
// 1786200000_updated_Buckets.js: `yarn db:migrate` replays every prior
// migration in a plain JS sandbox, and 1786122444_created_StorageUserBalances.js
// calls `require`, a Goja global that only exists inside PocketBase. The shape
// below follows 1786115038_created_StorageClaimAudit.js (select + autodate
// fields) and the StorageTransfers migration (Users relations).
migrate((app) => {
  const collection = new Collection({
    "id": "pb_stginvite93kd7x",
    "name": "StorageInvites",
    "type": "base",
    "system": false,
    // The invitee is deliberately absent from these rules: before the claim
    // they have no account to match on, and after it the invite is the
    // sender's record of what they gave away.
    "listRule": "from_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id",
    "viewRule": "from_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id",
    "createRule": "from_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id",
    "updateRule": null,
    "deleteRule": "from_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id",
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
      "name": "from_user",
      "id": "relinvfrmusr01",
      "type": "relation",
      "required": true,
      "collectionId": "_pb_users_auth_",
      "maxSelect": 1,
      "minSelect": 0,
      "cascadeDelete": true,
      "displayFields": null,
    },
    {
      "name": "to_email",
      "id": "textinvtoeml02",
      "type": "text",
      "required": true,
      "max": 255,
    },
    {
      "name": "quota_gb",
      "id": "numbinvquota03",
      "type": "number",
      "required": false,
      "min": 0.001,
    },
    {
      "name": "note",
      "id": "textinvnote04",
      "type": "text",
      "required": false,
      "max": 500,
    },
    {
      "name": "status",
      "id": "selinvstatus05",
      "type": "select",
      "required": false,
      "maxSelect": 1,
      "values": ["pending", "claimed", "failed"],
    },
    {
      "name": "settled_at",
      "id": "dateinvsettl06",
      "type": "date",
      "required": false,
    },
    {
      "name": "transfer_id",
      "id": "textinvxfer07",
      "type": "text",
      "required": false,
      "max": 32,
    },
    {
      "name": "failure_reason",
      "id": "textinvfail08",
      "type": "text",
      "required": false,
      "max": 500,
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
    "CREATE INDEX `idx_storageinvites_from_user` ON `StorageInvites` (`from_user`)",
    // The claim path looks invites up by address, so this is the hot one.
    "CREATE INDEX `idx_storageinvites_to_email` ON `StorageInvites` (`to_email`)",
  ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_stginvite93kd7x") // StorageInvites;
  return app.delete(collection);
});
