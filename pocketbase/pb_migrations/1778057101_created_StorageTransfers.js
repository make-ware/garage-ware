/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    "id": "pb_kzfdaulx3e249w8",
    "name": "StorageTransfers",
    "type": "base",
    "system": false,
    "listRule": "from_user = @request.auth.id || to_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id",
    "viewRule": "from_user = @request.auth.id || to_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id",
    "createRule": "from_user = @request.auth.id",
    "updateRule": null,
    "deleteRule": "to_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id",
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
      "id": "textgp5cnob63i",
      "type": "relation",
      "required": true,
      "collectionId": "_pb_users_auth_",
      "maxSelect": 1,
      "minSelect": 0,
      "cascadeDelete": true,
      "displayFields": null,
    },
    {
      "name": "to_user",
      "id": "textjrrk5vy9ng",
      "type": "relation",
      "required": true,
      "collectionId": "_pb_users_auth_",
      "maxSelect": 1,
      "minSelect": 0,
      "cascadeDelete": true,
      "displayFields": null,
    },
    {
      "name": "quota_gb",
      "id": "numberu7aitivdl6",
      "type": "number",
      "required": false,
      "min": 0.001,
    },
    {
      "name": "note",
      "id": "textva304bmfya",
      "type": "text",
      "required": false,
      "max": 500,
    },
  ],
    "indexes": [
    "CREATE INDEX `idx_storagetransfers_from_user` ON `StorageTransfers` (`from_user`)",
    "CREATE INDEX `idx_storagetransfers_to_user` ON `StorageTransfers` (`to_user`)",
  ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_kzfdaulx3e249w8") // StorageTransfers;
  return app.delete(collection);
});
