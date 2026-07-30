/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection_Users_perm_listRule = app.findCollectionByNameOrId("_pb_users_auth_") // Users;
  collection_Users_perm_listRule.listRule = "id = @request.auth.id || @collection.Admins.user ?= @request.auth.id";
  app.save(collection_Users_perm_listRule);

  const collection_Users_perm_viewRule = app.findCollectionByNameOrId("_pb_users_auth_") // Users;
  collection_Users_perm_viewRule.viewRule = "id = @request.auth.id || @collection.Admins.user ?= @request.auth.id";
  return app.save(collection_Users_perm_viewRule);

}, (app) => {
  const collection_Users_revert_perm_listRule = app.findCollectionByNameOrId("_pb_users_auth_") // Users;
  collection_Users_revert_perm_listRule.listRule = "id = @request.auth.id";
  app.save(collection_Users_revert_perm_listRule);

  const collection_Users_revert_perm_viewRule = app.findCollectionByNameOrId("_pb_users_auth_") // Users;
  collection_Users_revert_perm_viewRule.viewRule = "id = @request.auth.id";
  return app.save(collection_Users_revert_perm_viewRule);
});
