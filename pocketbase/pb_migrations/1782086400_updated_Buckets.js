/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection_Buckets_add_objects_0 = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;

  collection_Buckets_add_objects_0.fields.add(new NumberField({
    "name": "objects",
    "id": "numberobj9k2lm0a",
    "required": false,
    "min": 0
  }));

  app.save(collection_Buckets_add_objects_0);

  const collection_Buckets_add_max_size_1 = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;

  collection_Buckets_add_max_size_1.fields.add(new NumberField({
    "name": "max_size",
    "id": "numbermaxsz4w8c",
    "required": false,
    "min": 0
  }));

  app.save(collection_Buckets_add_max_size_1);

  const collection_Buckets_add_max_objects_2 = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;

  collection_Buckets_add_max_objects_2.fields.add(new NumberField({
    "name": "max_objects",
    "id": "numbermaxobj7q3z",
    "required": false,
    "min": 0
  }));

  return app.save(collection_Buckets_add_max_objects_2);
}, (app) => {
  const collection_Buckets_revert_add_objects = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;

  collection_Buckets_revert_add_objects.fields.removeByName("objects");

  app.save(collection_Buckets_revert_add_objects);

  const collection_Buckets_revert_add_max_size = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;

  collection_Buckets_revert_add_max_size.fields.removeByName("max_size");

  app.save(collection_Buckets_revert_add_max_size);

  const collection_Buckets_revert_add_max_objects = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;

  collection_Buckets_revert_add_max_objects.fields.removeByName("max_objects");

  return app.save(collection_Buckets_revert_add_max_objects);
});
