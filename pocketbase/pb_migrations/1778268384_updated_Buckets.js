/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection_Buckets_add_bytes_0 = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;

  collection_Buckets_add_bytes_0.fields.add(new NumberField({
    "name": "bytes",
    "id": "numberde3b2lhhk6",
    "required": false,
    "min": 0
  }));

  app.save(collection_Buckets_add_bytes_0);

  const collection_Buckets_add_usage_updated_at_1 = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;

  collection_Buckets_add_usage_updated_at_1.fields.add(new DateField({
    "name": "usage_updated_at",
    "id": "date6cqt3j2emd",
    "required": false
  }));

  return app.save(collection_Buckets_add_usage_updated_at_1);
}, (app) => {
  const collection_Buckets_revert_add_bytes = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;

  collection_Buckets_revert_add_bytes.fields.removeByName("bytes");

  app.save(collection_Buckets_revert_add_bytes);

  const collection_Buckets_revert_add_usage_updated_at = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;

  collection_Buckets_revert_add_usage_updated_at.fields.removeByName("usage_updated_at");

  return app.save(collection_Buckets_revert_add_usage_updated_at);
});
