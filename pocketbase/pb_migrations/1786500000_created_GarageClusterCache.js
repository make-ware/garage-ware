/// <reference path="../pb_data/types.d.ts" />
//
// Creates `GarageClusterCache`: the last-known Garage cluster responses, one
// row per kind of read ('layout', 'status', 'health', 'replication_factor').
// Read and written by the Next.js handlers via webapp/src/lib/garage/cached.ts,
// which serves the stored payload and refreshes it behind the response once it
// goes stale. Nothing in PocketBase touches this collection — no hook, no cron.
//
// A cache with a TTL, never a source of truth. Validators (claims, transfers,
// bucket quotas, invite settlement) keep fetching the layout live, because a
// stale layout must not decide whether capacity exists.
//
// All five rules are null: the payloads carry node addresses and hostnames the
// browser is never handed today, and the only client that touches this
// collection authenticates as a superuser, which bypasses collection rules
// anyway. Opening a read rule here would leak cluster internals.
//
// Hand-written rather than generated, for the reason documented in
// 1786200000_updated_Buckets.js: `yarn db:migrate` replays every prior
// migration in a plain JS sandbox, and 1786122444_created_StorageUserBalances.js
// calls `require`, a Goja global that only exists inside PocketBase. The shape
// below follows 1786400000_created_NodeMetrics.js, with the `date` field copied
// from StorageInvites' `settled_at`. Mirrors shared/src/schema/
// garage-cluster-cache.ts — keep the two in sync by hand.
//
// `payload` gets an explicit 2MB limit: PocketBase applies a 1MB default when
// maxSize is unset, and a GetClusterStatus body grows with the node count.
//
migrate((app) => {
  const collection = new Collection({
    "id": "pb_garageclcache01",
    "name": "GarageClusterCache",
    "type": "base",
    "system": false,
    "listRule": null,
    "viewRule": null,
    "createRule": null,
    "updateRule": null,
    "deleteRule": null,
    "fields": [
    {
      "name": "id",
      "id": "text3208210256",
      "type": "text",
      "required": true,
      "autogeneratePattern": "[a-z0-9]{15}",
      "hidden": false,
      "max": 15,
      "min": 15,
      "pattern": "^[a-z0-9]+$",
      "presentable": false,
      "primaryKey": true,
      "system": true,
    },
    {
      "name": "key",
      "id": "textgcckey0001",
      "type": "text",
      "required": true,
      "min": 1,
      "max": 64,
    },
    {
      "name": "payload",
      "id": "jsongccpayl002",
      "type": "json",
      "required": false,
      "maxSize": 2000000,
    },
    {
      // When Garage answered — the age the TTL is measured against. Not the
      // autodate `updated`, which moves on any write, including one that only
      // re-confirms what was already stored.
      "name": "fetched_at",
      "id": "dategccfetch03",
      "type": "date",
      "required": false,
    },
    {
      "name": "created",
      "id": "autodate2990389176",
      "type": "autodate",
      "required": false,
      "hidden": false,
      "onCreate": true,
      "onUpdate": false,
      "presentable": false,
      "system": true,
    },
    {
      "name": "updated",
      "id": "autodate3332085495",
      "type": "autodate",
      "required": false,
      "hidden": false,
      "onCreate": true,
      "onUpdate": true,
      "presentable": false,
      "system": true,
    },
  ],
    "indexes": [
    // Unique on purpose — one row per kind of read. The natural-key upsert in
    // GarageClusterCacheMutator relies on the DB rejecting a concurrent second
    // create so the loser can re-read and update instead of duplicating.
    "CREATE UNIQUE INDEX `idx_garageclustercache_key` ON `GarageClusterCache` (`key`)",
  ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_garageclcache01") // GarageClusterCache;
  return app.delete(collection);
});
