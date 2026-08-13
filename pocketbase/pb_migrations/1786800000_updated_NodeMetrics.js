/// <reference path="../pb_data/types.d.ts" />
//
// Adds the five columns the cluster-events detector diffs against (see
// pocketbase/pb_hooks/lib/cluster-events.js). Every one of them comes from a
// call scrapeOnce already makes — no new Garage traffic, and no new state
// store: "the previous observation" is just the previous NodeMetrics row.
//
//   role_ok             — the new gate, and the subtle one. It does NOT mean
//                         "this node has a role"; it means "this row was
//                         written by a scraper that records the role fields",
//                         and is set whenever layout_ok is, including for a
//                         node with no role at all.
//   role_capacity_bytes — layout roles[].capacity for this node. 0 is a REAL
//                         reading under role_ok: a gateway, or a node with no
//                         role in the current layout.
//   node_tags           — layout roles[].tags, comma-joined. Carries the
//                         `name:` tag, so an operator renaming a node shows up
//                         on the timeline as a change rather than silently.
//   layout_version      — layout.version. Cluster-wide, denormalized per row
//                         exactly as partition_size_bytes already is, so a bump
//                         is detectable from any node's previous row.
//   garage_version      — status nodes[].garageVersion. Not gated: it comes
//                         from GetClusterStatus, whose failure aborts the whole
//                         scrape, so "" simply means the node did not report one.
//
// Why role_ok has to exist. PocketBase number fields cannot hold null, so an
// absent role_capacity_bytes reads back as 0 — and 0 is also what a gateway
// legitimately reports. Without a gate, the first scrape after this migration
// would compare every storage node's brand-new 16 TB against the 0 its older
// rows read back as, and emit a spurious `capacity_changed` for each. Existing
// rows read role_ok = false, the detector refuses to diff against them, and the
// first event it can emit is a change it actually watched happen.
//
// No backfill, for the same reason as 1786700000: those samples carry no role
// reading, and inventing one would be worse than admitting the gap.
//
// Hand-written rather than generated. `yarn db:migrate` cannot run against this
// repo's migration history (see 1786200000_updated_Buckets.js for why). Mirrors
// shared/src/schema/node-metric.ts — keep the two in sync by hand. onlyInt/max
// are set up front, as on the columns 1786400000_created_NodeMetrics.js already
// carries.
migrate((app) => {
  const collection_NodeMetrics_add_role = app.findCollectionByNameOrId("pb_nodemetrics4x7z") // NodeMetrics;

  collection_NodeMetrics_add_role.fields.add(new BoolField({
    // A required bool in PB means "must be true" — keep this false.
    "name": "role_ok",
    "id": "boolnmroleok01",
    "required": false
  }));

  collection_NodeMetrics_add_role.fields.add(new NumberField({
    "name": "role_capacity_bytes",
    "id": "numbernmrcb00001",
    "required": false,
    "min": 0,
    "max": 9007199254740991,
    "onlyInt": true
  }));

  collection_NodeMetrics_add_role.fields.add(new TextField({
    "name": "node_tags",
    "id": "textnmtags00001",
    "required": false,
    "max": 500
  }));

  collection_NodeMetrics_add_role.fields.add(new NumberField({
    "name": "layout_version",
    "id": "numbernmlver0001",
    "required": false,
    "min": 0,
    "max": 9007199254740991,
    "onlyInt": true
  }));

  collection_NodeMetrics_add_role.fields.add(new TextField({
    "name": "garage_version",
    "id": "textnmgver00001",
    "required": false,
    "max": 64
  }));

  return app.save(collection_NodeMetrics_add_role);
}, (app) => {
  const collection_NodeMetrics_revert_role = app.findCollectionByNameOrId("pb_nodemetrics4x7z") // NodeMetrics;

  collection_NodeMetrics_revert_role.fields.removeByName("role_ok");
  collection_NodeMetrics_revert_role.fields.removeByName("role_capacity_bytes");
  collection_NodeMetrics_revert_role.fields.removeByName("node_tags");
  collection_NodeMetrics_revert_role.fields.removeByName("layout_version");
  collection_NodeMetrics_revert_role.fields.removeByName("garage_version");

  return app.save(collection_NodeMetrics_revert_role);
});
