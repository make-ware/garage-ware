/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    "id": "pb_032yrgxtgiabbg2",
    "name": "Buckets",
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
      "cascadeDelete": false,
      "displayFields": null,
    },
    {
      "name": "garage_bucket_id",
      "id": "textn81wrfm6ee",
      "type": "text",
      "required": true,
    },
    {
      "name": "name",
      "id": "textwtltyd0sur",
      "type": "text",
      "required": true,
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
    "CREATE UNIQUE INDEX `idx_buckets_garage_bucket_id` ON `Buckets` (`garage_bucket_id`)",
    "CREATE UNIQUE INDEX `idx_buckets_name` ON `Buckets` (`name`)",
    "CREATE INDEX `idx_buckets_user` ON `Buckets` (`user`)",
  ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;
  return app.delete(collection);
});
