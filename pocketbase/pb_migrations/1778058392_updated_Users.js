/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection_Users_add_notification_threshold_pct_0 = app.findCollectionByNameOrId("_pb_users_auth_") // Users;

  collection_Users_add_notification_threshold_pct_0.fields.add(new NumberField({
    "name": "notification_threshold_pct",
    "id": "number5vhlg57of6",
    "required": false,
    "min": 0,
    "max": 90
  }));

  return app.save(collection_Users_add_notification_threshold_pct_0);
}, (app) => {
  const collection_Users_revert_add_notification_threshold_pct = app.findCollectionByNameOrId("_pb_users_auth_") // Users;

  collection_Users_revert_add_notification_threshold_pct.fields.removeByName("notification_threshold_pct");

  return app.save(collection_Users_revert_add_notification_threshold_pct);
});
