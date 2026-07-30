/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    "id": "pb_71igpo3jjenzjd0",
    "name": "StorageClaims",
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
      "id": "texte6jbx1dz77",
      "type": "relation",
      "required": true,
      "collectionId": "_pb_users_auth_",
      "maxSelect": 1,
      "minSelect": 0,
      "cascadeDelete": true,
      "displayFields": null,
    },
    {
      "name": "node_id",
      "id": "texta8btjpu7d5",
      "type": "text",
      "required": true,
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
      "name": "quota_gb",
      "id": "numberu7aitivdl6",
      "type": "number",
      "required": false,
      "min": 0,
    },
     {
      "name": "created",
      "id": "autodate2990389177",
      "type": "autodate",
      "onCreate": true,
      "onUpdate": false,
      "presentable": false,
      "system": false,
      "hidden": false,
    },
    {
      "name": "updated",
      "id": "autodate3332085496",
      "type": "autodate",
      "onCreate": true,
      "onUpdate": true,
      "presentable": false,
      "system": false,
      "hidden": false,
    },
  ],
    "indexes": [
    "CREATE UNIQUE INDEX `idx_storageclaims_user_node` ON `StorageClaims` (`user`, `node_id`)",
    "CREATE INDEX `idx_storageclaims_user` ON `StorageClaims` (`user`)",
    "CREATE INDEX `idx_storageclaims_node` ON `StorageClaims` (`node_id`)",
  ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  return app.delete(collection);
});
