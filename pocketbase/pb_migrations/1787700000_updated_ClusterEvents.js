/// <reference path="../pb_data/types.d.ts" />
//
// Adds `ClusterEvents.occurrence_count`: how many times an ongoing condition
// has opened on one row.
//
// The detector no longer writes a row per edge for the two ONGOING_KINDS
// (`node_state`, `node_removed`). It opens one row, closes it when the
// condition clears, and — if the same condition recurs within FLAP_WINDOW_SEC —
// re-opens that same row and bumps this counter rather than appending another.
// A node flapping across four scrapes is one timeline entry reading "3
// occurrences", not four rows fifteen minutes apart. See
// pocketbase/pb_hooks/lib/cluster-events.js.
//
// 0 is the "not applicable" value, deliberately: an absent PocketBase number
// field reads back as 0, so every row predating this column — and every
// point-in-time row, which never opens at all — reads correctly without being
// touched. Only the ongoing rows ever carry 1 or more, and the UI renders the
// figure from 2 up.
//
// Hand-written rather than generated. `yarn db:migrate` cannot run against this
// repo's migration history: it replays each prior migration in a plain JS
// sandbox, and 1786122444_created_StorageUserBalances.js calls `require`, which
// only exists inside PocketBase's Goja runtime. The shape below follows
// 1786200000_updated_Buckets.js, including the explicit `id` — a generated
// field id would differ between environments and PocketBase keys columns on it.
//
// Ships alongside 1787800000_close_legacy_events.js and must be applied before
// it; that one is what makes `ended_at` mean the same thing on old rows as on
// new ones.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pb_clusterevt7k2q9") // ClusterEvents;

  collection.fields.add(new NumberField({
    "name": "occurrence_count",
    "id": "numberceoccur1",
    "required": false,
    "min": 0,
    "max": 9007199254740991,
    "onlyInt": true
  }));

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_clusterevt7k2q9") // ClusterEvents;

  collection.fields.removeByName("occurrence_count");

  return app.save(collection);
});
