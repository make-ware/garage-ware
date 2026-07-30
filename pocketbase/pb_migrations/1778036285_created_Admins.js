/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    "id": "pb_vjq8pygu7ujoe6t",
    "name": "Admins",
    "type": "base",
    "system": false,
    "listRule": "@collection.Admins.user ?= @request.auth.id",
    "viewRule": "@collection.Admins.user ?= @request.auth.id",
    "createRule": "@collection.Admins.user ?= @request.auth.id",
    "updateRule": "@collection.Admins.user ?= @request.auth.id",
    "deleteRule": "@collection.Admins.user ?= @request.auth.id",
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
    "CREATE UNIQUE INDEX `idx_admins_user` ON `Admins` (`user`)",
  ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_vjq8pygu7ujoe6t") // Admins;
  return app.delete(collection);
});
