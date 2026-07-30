/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("_pb_users_auth_")

  // update field
  collection.fields.addAt(10, new Field({
    "hidden": false,
    "id": "number5vhlg57of6",
    "max": 99,
    "min": 0,
    "name": "notification_threshold_pct",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("_pb_users_auth_")

  // update field
  collection.fields.addAt(10, new Field({
    "hidden": false,
    "id": "number5vhlg57of6",
    "max": 90,
    "min": 0,
    "name": "notification_threshold_pct",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  return app.save(collection)
})
