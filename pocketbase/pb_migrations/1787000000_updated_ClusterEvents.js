/// <reference path="../pb_data/types.d.ts" />
//
// Opens two closed enums on ClusterEvents so an admin-launched Garage repair
// can be recorded on the timeline:
//
//   kind   += "repair"   — a repair operation was launched. ONE kind, not one
//                          per operation: `kind` says what sort of thing
//                          happened, and which repair it was lives in
//                          `new_value`, raw, as everything else here does.
//   source += "action"   — written by POST /next-api/garage/repairs.
//
// Why "action" and not "manual", which is the whole reason this migration
// exists rather than reusing what is already there. "Under repair" is the query
// `source = "manual" && ended_at = ""` (ClusterEventMutator.listOpenManual),
// and launching a repair is instantaneous — nothing ever closes it. A repair
// row written as `manual` would pin its node "under repair" for ever, amber on
// every node card, until somebody hand-closed a row that was never open. A
// third source value keeps that query character-for-character correct and
// touches no existing filter or index.
//
// Three things to know before editing this file:
//
//  1. THE FIELD IDS MUST STAY BYTE-IDENTICAL to 1786900000_created_ClusterEvents
//     ("selcekind00001", "selcesource001"). This migration mutates the existing
//     field in place via fields.getByName — the idiom
//     1785361304_updated_StorageClaims.js uses — precisely so the id cannot
//     drift. Re-adding a select with a fresh id would create a SECOND column
//     and every existing row's kind/source would read back empty. That is the
//     one way to lose the timeline.
//
//  2. The value arrays must stay in the same order as CLUSTER_EVENT_KINDS and
//     CLUSTER_EVENT_SOURCES in shared/src/schema/cluster-event.ts. The two
//     files are kept in sync by hand, as 1786800000 and 1786900000 already note.
//     Hand-written because `yarn db:migrate` cannot run against this repo's
//     migration history at all (see 1786200000_updated_Buckets.js).
//
//  3. `values` is REASSIGNED to a fresh array rather than pushed to. Goja does
//     not reliably propagate an in-place mutation of a slice-backed property
//     back to the Go struct; assigning a whole array does.
//
// The `down` CANNOT succeed against a database that already holds rows carrying
// kind "repair" or source "action" — PocketBase will reject the save rather
// than strand values that no longer exist in the enum. Delete those rows first:
//   DELETE FROM ClusterEvents WHERE kind = 'repair' OR source = 'action';
// Same class of caveat as 1785361304_updated_StorageClaims.js, which documents
// its own irreversibility for the same reason.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pb_clusterevt7k2q9") // ClusterEvents;

  collection.fields.getByName("kind").values = [
    "layout_version",
    "node_added",
    "node_removed",
    "capacity_changed",
    "zone_changed",
    "tags_changed",
    "disk_changed",
    "data_drop",
    "node_state",
    "version_changed",
    "note",
    "repair",
  ];

  collection.fields.getByName("source").values = ["detector", "manual", "action"];

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_clusterevt7k2q9") // ClusterEvents;

  collection.fields.getByName("kind").values = [
    "layout_version",
    "node_added",
    "node_removed",
    "capacity_changed",
    "zone_changed",
    "tags_changed",
    "disk_changed",
    "data_drop",
    "node_state",
    "version_changed",
    "note",
  ];

  collection.fields.getByName("source").values = ["detector", "manual"];

  return app.save(collection);
});
