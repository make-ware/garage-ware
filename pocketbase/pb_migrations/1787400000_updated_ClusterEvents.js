/// <reference path="../pb_data/types.d.ts" />
//
// Opens the ClusterEvents `kind` enum for node ownership:
//
//   kind += "node_owner_changed"   — a node was claimed, released, or
//                                    revoked/reassigned by an admin.
//
// ONE kind, not three, for the same reason "repair" is one kind and not one per
// operation (1787000000_updated_ClusterEvents.js): `kind` says what sort of
// thing happened, and which of the three verbs it was reads straight off
// previous_value / new_value, which carry the raw PB user ids — empty meaning
// unowned. Three kinds would buy three KIND_LABELS entries and three filter
// options for one concept.
//
// `source` needs no change: these rows are written by
// /next-api/garage/nodes/owners as "action", the value 1787000000 already
// added for repairs. That matters — an ownership row must not be "manual",
// because the "under repair" marker is `source = "manual" && ended_at = ""`
// and would pin the node amber for ever.
//
// Three things to know before editing this file, as 1787000000 documents:
//
//  1. THE FIELD ID MUST STAY BYTE-IDENTICAL ("selcekind00001"). This mutates
//     the existing field in place via fields.getByName so the id cannot drift.
//     Re-adding a select with a fresh id would create a SECOND column and every
//     existing row's kind would read back empty. That is the one way to lose
//     the timeline.
//  2. The value array must stay in the same order as CLUSTER_EVENT_KINDS in
//     shared/src/schema/cluster-event.ts. Kept in sync by hand, because
//     `yarn db:migrate` cannot run against this repo's migration history at all
//     (see 1786200000_updated_Buckets.js).
//  3. `values` is REASSIGNED to a fresh array rather than pushed to. Goja does
//     not reliably propagate an in-place mutation of a slice-backed property
//     back to the Go struct; assigning a whole array does.
//
// The `down` CANNOT succeed against a database already holding rows with kind
// "node_owner_changed" — PocketBase rejects the save rather than strand values
// outside the enum. Delete those rows first:
//   DELETE FROM ClusterEvents WHERE kind = 'node_owner_changed';
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
    "node_owner_changed",
  ];

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
    "repair",
  ];

  return app.save(collection);
});
