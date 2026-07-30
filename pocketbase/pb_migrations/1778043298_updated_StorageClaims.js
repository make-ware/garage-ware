/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0")

  // update collection data
  unmarshal({
    "createRule": "@collection.Admins.user ?= @request.auth.id",
    "deleteRule": "@collection.Admins.user ?= @request.auth.id",
    "updateRule": "@collection.Admins.user ?= @request.auth.id"
  }, collection)

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0")

  // update collection data
  unmarshal({
    "createRule": null,
    "deleteRule": null,
    "updateRule": null
  }, collection)

  return app.save(collection)
})
