/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection_StorageClaims_modify_node_id = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  const collection_StorageClaims_modify_node_id_field = collection_StorageClaims_modify_node_id.fields.getByName("node_id");

  collection_StorageClaims_modify_node_id_field.min = 1;
  collection_StorageClaims_modify_node_id_field.max = 128;

  return app.save(collection_StorageClaims_modify_node_id);
}, (app) => {
  const collection_StorageClaims_revert_node_id = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  const collection_StorageClaims_revert_node_id_field = collection_StorageClaims_revert_node_id.fields.getByName("node_id");

  collection_StorageClaims_revert_node_id_field.min = 0;
  collection_StorageClaims_revert_node_id_field.max = 0;

  return app.save(collection_StorageClaims_revert_node_id);
});
