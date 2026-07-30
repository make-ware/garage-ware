/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection_AccessKeys_perm_createRule = app.findCollectionByNameOrId("pb_eq35ufwm9d4ca18") // AccessKeys;
  collection_AccessKeys_perm_createRule.createRule = "user = @request.auth.id || @collection.Admins.user ?= @request.auth.id";
  app.save(collection_AccessKeys_perm_createRule);

  const collection_AccessKeys_perm_updateRule = app.findCollectionByNameOrId("pb_eq35ufwm9d4ca18") // AccessKeys;
  collection_AccessKeys_perm_updateRule.updateRule = "user = @request.auth.id || @collection.Admins.user ?= @request.auth.id";
  app.save(collection_AccessKeys_perm_updateRule);

  const collection_AccessKeys_perm_deleteRule = app.findCollectionByNameOrId("pb_eq35ufwm9d4ca18") // AccessKeys;
  collection_AccessKeys_perm_deleteRule.deleteRule = "user = @request.auth.id || @collection.Admins.user ?= @request.auth.id";
  return app.save(collection_AccessKeys_perm_deleteRule);

}, (app) => {
  const collection_AccessKeys_revert_perm_createRule = app.findCollectionByNameOrId("pb_eq35ufwm9d4ca18") // AccessKeys;
  collection_AccessKeys_revert_perm_createRule.createRule = null;
  app.save(collection_AccessKeys_revert_perm_createRule);

  const collection_AccessKeys_revert_perm_updateRule = app.findCollectionByNameOrId("pb_eq35ufwm9d4ca18") // AccessKeys;
  collection_AccessKeys_revert_perm_updateRule.updateRule = null;
  app.save(collection_AccessKeys_revert_perm_updateRule);

  const collection_AccessKeys_revert_perm_deleteRule = app.findCollectionByNameOrId("pb_eq35ufwm9d4ca18") // AccessKeys;
  collection_AccessKeys_revert_perm_deleteRule.deleteRule = null;
  return app.save(collection_AccessKeys_revert_perm_deleteRule);

});
