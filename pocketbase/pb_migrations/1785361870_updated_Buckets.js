/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection_Buckets_modify_garage_bucket_id = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;
  const collection_Buckets_modify_garage_bucket_id_field = collection_Buckets_modify_garage_bucket_id.fields.getByName("garage_bucket_id");

  collection_Buckets_modify_garage_bucket_id_field.min = 1;
  collection_Buckets_modify_garage_bucket_id_field.max = 128;

  app.save(collection_Buckets_modify_garage_bucket_id);

  const collection_Buckets_modify_name = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;
  const collection_Buckets_modify_name_field = collection_Buckets_modify_name.fields.getByName("name");

  collection_Buckets_modify_name_field.min = 1;
  collection_Buckets_modify_name_field.max = 63;

  app.save(collection_Buckets_modify_name);

  const collection_Buckets_modify_bytes = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;
  const collection_Buckets_modify_bytes_field = collection_Buckets_modify_bytes.fields.getByName("bytes");

  collection_Buckets_modify_bytes_field.max = 9007199254740991;
  collection_Buckets_modify_bytes_field.onlyInt = true;

  app.save(collection_Buckets_modify_bytes);

  const collection_Buckets_modify_objects = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;
  const collection_Buckets_modify_objects_field = collection_Buckets_modify_objects.fields.getByName("objects");

  collection_Buckets_modify_objects_field.max = 9007199254740991;
  collection_Buckets_modify_objects_field.onlyInt = true;

  app.save(collection_Buckets_modify_objects);

  const collection_Buckets_modify_max_size = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;
  const collection_Buckets_modify_max_size_field = collection_Buckets_modify_max_size.fields.getByName("max_size");

  collection_Buckets_modify_max_size_field.max = 9007199254740991;
  collection_Buckets_modify_max_size_field.onlyInt = true;

  app.save(collection_Buckets_modify_max_size);

  const collection_Buckets_modify_max_objects = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;
  const collection_Buckets_modify_max_objects_field = collection_Buckets_modify_max_objects.fields.getByName("max_objects");

  collection_Buckets_modify_max_objects_field.max = 9007199254740991;
  collection_Buckets_modify_max_objects_field.onlyInt = true;

  return app.save(collection_Buckets_modify_max_objects);
}, (app) => {
  const collection_Buckets_revert_garage_bucket_id = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;
  const collection_Buckets_revert_garage_bucket_id_field = collection_Buckets_revert_garage_bucket_id.fields.getByName("garage_bucket_id");

  collection_Buckets_revert_garage_bucket_id_field.min = 0;
  collection_Buckets_revert_garage_bucket_id_field.max = 0;

  app.save(collection_Buckets_revert_garage_bucket_id);

  const collection_Buckets_revert_name = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;
  const collection_Buckets_revert_name_field = collection_Buckets_revert_name.fields.getByName("name");

  collection_Buckets_revert_name_field.min = 0;
  collection_Buckets_revert_name_field.max = 0;

  app.save(collection_Buckets_revert_name);

  const collection_Buckets_revert_bytes = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;
  const collection_Buckets_revert_bytes_field = collection_Buckets_revert_bytes.fields.getByName("bytes");

  collection_Buckets_revert_bytes_field.max = null;
  collection_Buckets_revert_bytes_field.onlyInt = false;

  app.save(collection_Buckets_revert_bytes);

  const collection_Buckets_revert_objects = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;
  const collection_Buckets_revert_objects_field = collection_Buckets_revert_objects.fields.getByName("objects");

  collection_Buckets_revert_objects_field.max = null;
  collection_Buckets_revert_objects_field.onlyInt = false;

  app.save(collection_Buckets_revert_objects);

  const collection_Buckets_revert_max_size = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;
  const collection_Buckets_revert_max_size_field = collection_Buckets_revert_max_size.fields.getByName("max_size");

  collection_Buckets_revert_max_size_field.max = null;
  collection_Buckets_revert_max_size_field.onlyInt = false;

  app.save(collection_Buckets_revert_max_size);

  const collection_Buckets_revert_max_objects = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;
  const collection_Buckets_revert_max_objects_field = collection_Buckets_revert_max_objects.fields.getByName("max_objects");

  collection_Buckets_revert_max_objects_field.max = null;
  collection_Buckets_revert_max_objects_field.onlyInt = false;

  return app.save(collection_Buckets_revert_max_objects);
});
