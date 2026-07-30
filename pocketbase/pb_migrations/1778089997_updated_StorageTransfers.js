/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection_StorageTransfers_perm_createRule = app.findCollectionByNameOrId("pb_kzfdaulx3e249w8") // StorageTransfers;
  collection_StorageTransfers_perm_createRule.createRule = "from_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id";
  return app.save(collection_StorageTransfers_perm_createRule);
}, (app) => {
  const collection_StorageTransfers_revert_perm_createRule = app.findCollectionByNameOrId("pb_kzfdaulx3e249w8") // StorageTransfers;
  collection_StorageTransfers_revert_perm_createRule.createRule = "from_user = @request.auth.id";
  return app.save(collection_StorageTransfers_revert_perm_createRule);
});
