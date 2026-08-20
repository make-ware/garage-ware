/// <reference path="../pb_data/types.d.ts" />
//
// Opens the ClusterEvents `kind` enum for layout staging:
//
//   kind += "layout_staged"   — an admin staged a cluster layout change
//                               (a role assigned/changed, or a node marked for
//                               removal) through /admin/cluster/staging.
//
// ONE kind, not one per verb, for the reason 1787400000 gives for
// "node_owner_changed" and 1787000000 gives for "repair": `kind` says what sort
// of thing happened, and which verb it was reads straight off previous_value /
// new_value — the raw role (`zone=dc1;capacity=32000000000000;tags=ssd`) or the
// literal "remove".
//
// Staged, NOT applied. garage-ware never calls ApplyClusterLayout; these rows
// record a change waiting in Garage's pending area for a human to commit with
// `garage layout apply --version N+1`. The applied version bump arrives
// separately, from the detector, as "layout_version".
//
// `source` needs no change: these rows are written by
// /next-api/garage/cluster/staging as "action", the value 1787000000 already
// added. That matters — a staging row must not be "manual", because the "under
// repair" marker is `source = "manual" && ended_at = ""` and would pin the node
// amber for ever.
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
// "layout_staged" — PocketBase rejects the save rather than strand values
// outside the enum. Delete those rows first:
//   DELETE FROM ClusterEvents WHERE kind = 'layout_staged';
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
    "layout_staged",
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
    "node_owner_changed",
  ];

  return app.save(collection);
});
