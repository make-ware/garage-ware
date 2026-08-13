/// <reference path="../pb_data/types.d.ts" />
//
// ClusterEvents — the cluster timeline behind /admin/events.
//
// Two authors, one collection. The `node-metrics-scrape` cron writes detector
// rows (see pb_hooks/lib/cluster-events.js) by diffing each scrape against the
// previous one; an admin writes `note` rows and annotations through
// /next-api/garage/events. `source` is what tells them apart.
//
// Why the collection exists rather than being read from Garage: Garage keeps no
// history of itself. There is no event stream, no webhook and no attribution in
// the admin API, and GetClusterLayoutHistory returns per-version node *counts*
// with no timestamps and no role detail, so a past layout change cannot be
// reconstructed after the fact. A change is only observable in the moment two
// consecutive samples disagree.
//
// node_id / node_hostname / node_zone are plain text, not relations: nodes are
// Garage entities with no PB counterpart, and a `node_removed` row has to
// outlive the node it describes. Same reasoning as StorageClaimAudit.
//
// All three write rules are null. The cron writes through the Go/JSVM layer and
// the route handlers write as a superuser, both of which bypass collection
// rules — so locking writes costs nothing and makes the log genuinely
// append-only from a browser.
//
// occurred_at, not created, is the sort key and carries the indexes: a note
// written today about last Tuesday belongs on last Tuesday. ended_at empty
// means "still open", and an open manual row pinned to a node is what marks
// that node "under repair" on the events page — hence the (source, ended_at)
// index, which is the one query every page load runs.
//
// Nothing prunes this collection, unlike NodeMetrics. It grows by a handful of
// rows a week and the whole point is to remember further back than the metrics
// it explains.
//
// Hand-written rather than generated: `yarn db:migrate` cannot run against this
// repo's migration history (see 1786200000_updated_Buckets.js). Mirrors
// shared/src/schema/cluster-event.ts — keep the two in sync by hand.
migrate((app) => {
  const collection = new Collection({
    "id": "pb_clusterevt7k2q9",
    "name": "ClusterEvents",
    "type": "base",
    "system": false,
    "listRule": "@collection.Admins.user ?= @request.auth.id",
    "viewRule": "@collection.Admins.user ?= @request.auth.id",
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
      "name": "kind",
      "id": "selcekind00001",
      "type": "select",
      "required": true,
      "maxSelect": 1,
      "values": [
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
      ],
    },
    {
      "name": "source",
      "id": "selcesource001",
      "type": "select",
      "required": true,
      "maxSelect": 1,
      "values": ["detector", "manual"],
    },
    {
      "name": "severity",
      "id": "selceseverity1",
      "type": "select",
      "required": false,
      "maxSelect": 1,
      "values": ["info", "warning", "critical"],
    },
    { "name": "node_id", "id": "textcenodeid01", "type": "text", "required": false, "max": 128 },
    { "name": "node_hostname", "id": "textcehost0001", "type": "text", "required": false, "max": 255 },
    { "name": "node_zone", "id": "textcezone0001", "type": "text", "required": false, "max": 64 },
    { "name": "title", "id": "textcetitle001", "type": "text", "required": true, "max": 200 },
    { "name": "detail", "id": "textcedetail01", "type": "text", "required": false, "max": 2000 },
    // Raw values, never rendered strings — the UI formats by `kind`, so a row
    // stays re-renderable when the formatting changes.
    { "name": "previous_value", "id": "textceprev0001", "type": "text", "required": false, "max": 255 },
    { "name": "new_value", "id": "textcenew00001", "type": "text", "required": false, "max": 255 },
    {
      "name": "category",
      "id": "selcecategory1",
      "type": "select",
      "required": false,
      "maxSelect": 1,
      "values": [
        "hardware-failure",
        "disk-replaced",
        "maintenance",
        "upgrade",
        "incident",
        "decommission",
        "other",
      ],
    },
    { "name": "occurred_at", "id": "datececcurred1", "type": "date", "required": true },
    { "name": "ended_at", "id": "dateceended001", "type": "date", "required": false },
    { "name": "annotation", "id": "textceannot001", "type": "text", "required": false, "max": 2000 },
    { "name": "annotated_by", "id": "textceannby001", "type": "text", "required": false, "max": 255 },
    { "name": "annotated_at", "id": "dateceannat001", "type": "date", "required": false },
    { "name": "actor_id", "id": "textceactor001", "type": "text", "required": false, "max": 32 },
    { "name": "actor_email", "id": "textceactem001", "type": "text", "required": false, "max": 255 },
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
    "CREATE INDEX `idx_clusterevents_occurred` ON `ClusterEvents` (`occurred_at`)",
    "CREATE INDEX `idx_clusterevents_node_occurred` ON `ClusterEvents` (`node_id`, `occurred_at`)",
    "CREATE INDEX `idx_clusterevents_kind` ON `ClusterEvents` (`kind`)",
    // The "under repair" lookup: open manual rows, run on every page load.
    "CREATE INDEX `idx_clusterevents_source_ended` ON `ClusterEvents` (`source`, `ended_at`)",
  ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_clusterevt7k2q9") // ClusterEvents;
  return app.delete(collection);
});
