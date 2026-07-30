/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    "id": "pb_eq35ufwm9d4ca18",
    "name": "AccessKeys",
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
      "name": "garage_key_id",
      "id": "textgtd95xwrhq",
      "type": "text",
      "required": true,
    },
    {
      "name": "name",
      "id": "textwtltyd0sur",
      "type": "text",
      "required": false,
      "max": 100,
    },
    {
      "name": "created",
      "id": "autodate2990389176",
      "type": "autodate",
      "onCreate": true,
      "onUpdate": false,
      "presentable": false,
      "system": false,
      "hidden": false,
    },
    {
      "name": "updated",
      "id": "autodate3332085495",
      "type": "autodate",
      "onCreate": true,
      "onUpdate": true,
      "presentable": false,
      "system": false,
      "hidden": false,
    },
  ],
    "indexes": [
    "CREATE UNIQUE INDEX `idx_accesskeys_garage_key_id` ON `AccessKeys` (`garage_key_id`)",
    "CREATE INDEX `idx_accesskeys_user` ON `AccessKeys` (`user`)",
  ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_eq35ufwm9d4ca18") // AccessKeys;
  return app.delete(collection);
});
