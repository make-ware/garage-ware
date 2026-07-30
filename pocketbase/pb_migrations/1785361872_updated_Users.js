/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection_Users_modify_notification_threshold_pct = app.findCollectionByNameOrId("_pb_users_auth_") // Users;
  const collection_Users_modify_notification_threshold_pct_field = collection_Users_modify_notification_threshold_pct.fields.getByName("notification_threshold_pct");

  collection_Users_modify_notification_threshold_pct_field.onlyInt = true;

  return app.save(collection_Users_modify_notification_threshold_pct);
}, (app) => {
  const collection_Users_revert_notification_threshold_pct = app.findCollectionByNameOrId("_pb_users_auth_") // Users;
  const collection_Users_revert_notification_threshold_pct_field = collection_Users_revert_notification_threshold_pct.fields.getByName("notification_threshold_pct");

  collection_Users_revert_notification_threshold_pct_field.onlyInt = false;

  return app.save(collection_Users_revert_notification_threshold_pct);
});
