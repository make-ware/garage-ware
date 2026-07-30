/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection_AccessKeys_modify_garage_key_id = app.findCollectionByNameOrId("pb_eq35ufwm9d4ca18") // AccessKeys;
  const collection_AccessKeys_modify_garage_key_id_field = collection_AccessKeys_modify_garage_key_id.fields.getByName("garage_key_id");

  collection_AccessKeys_modify_garage_key_id_field.min = 1;
  collection_AccessKeys_modify_garage_key_id_field.max = 128;

  return app.save(collection_AccessKeys_modify_garage_key_id);
}, (app) => {
  const collection_AccessKeys_revert_garage_key_id = app.findCollectionByNameOrId("pb_eq35ufwm9d4ca18") // AccessKeys;
  const collection_AccessKeys_revert_garage_key_id_field = collection_AccessKeys_revert_garage_key_id.fields.getByName("garage_key_id");

  collection_AccessKeys_revert_garage_key_id_field.min = 0;
  collection_AccessKeys_revert_garage_key_id_field.max = 0;

  return app.save(collection_AccessKeys_revert_garage_key_id);
});
