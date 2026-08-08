/// <reference path="../pb_data/types.d.ts" />
//
// Adds `Buckets.object_quota`: the admin override for Garage's per-bucket
// `maxObjects` cap. Authoritative when > 0; 0 / unset keeps the historical
// behaviour of deriving the cap from `quota_gb` via GARAGE_AVG_OBJECT_SIZE_MB.
//
// Hand-written rather than generated. `yarn db:migrate` cannot run against this
// repo's migration history: it replays each prior migration in a plain JS
// sandbox, and 1786122444_created_StorageUserBalances.js calls `require`, which
// only exists inside PocketBase's Goja runtime. The shape below follows
// 1778268384_updated_Buckets.js, with the `onlyInt` / `max` pair that
// 1785361870_updated_Buckets.js had to backfill onto the other integer columns
// because the generator omits them — set here up front so this field does not
// need the same follow-up.
migrate((app) => {
  const collection_Buckets_add_object_quota = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;

  collection_Buckets_add_object_quota.fields.add(new NumberField({
    "name": "object_quota",
    "id": "numberobjq7x2la",
    "required": false,
    "min": 0,
    "max": 9007199254740991,
    "onlyInt": true
  }));

  return app.save(collection_Buckets_add_object_quota);
}, (app) => {
  const collection_Buckets_revert_add_object_quota = app.findCollectionByNameOrId("pb_032yrgxtgiabbg2") // Buckets;

  collection_Buckets_revert_add_object_quota.fields.removeByName("object_quota");

  return app.save(collection_Buckets_revert_add_object_quota);
});
