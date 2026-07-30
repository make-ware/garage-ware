/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection_StorageClaims_perm_createRule = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  collection_StorageClaims_perm_createRule.createRule = "@collection.Admins.user ?= @request.auth.id";
  app.save(collection_StorageClaims_perm_createRule);

  const collection_StorageClaims_perm_updateRule = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  collection_StorageClaims_perm_updateRule.updateRule = "@collection.Admins.user ?= @request.auth.id";
  app.save(collection_StorageClaims_perm_updateRule);

  const collection_StorageClaims_perm_deleteRule = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  collection_StorageClaims_perm_deleteRule.deleteRule = "@collection.Admins.user ?= @request.auth.id";
  return app.save(collection_StorageClaims_perm_deleteRule);

}, (app) => {
  const collection_StorageClaims_revert_perm_createRule = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  collection_StorageClaims_revert_perm_createRule.createRule = null;
  app.save(collection_StorageClaims_revert_perm_createRule);

  const collection_StorageClaims_revert_perm_updateRule = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  collection_StorageClaims_revert_perm_updateRule.updateRule = null;
  app.save(collection_StorageClaims_revert_perm_updateRule);

  const collection_StorageClaims_revert_perm_deleteRule = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  collection_StorageClaims_revert_perm_deleteRule.deleteRule = null;
  return app.save(collection_StorageClaims_revert_perm_deleteRule);

});
