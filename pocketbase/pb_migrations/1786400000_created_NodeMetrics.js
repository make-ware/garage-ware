/// <reference path="../pb_data/types.d.ts" />
//
// Per-node time-series of cluster health, appended every 15 minutes by the
// `node-metrics-scrape` cron in pb_hooks/main.pb.js (scraper in
// pb_hooks/lib/node-metrics.js). One row = one node at one sample time; the
// sample timestamp is the autodate `created`. The cron also prunes rows older
// than NODE_METRICS_RETENTION_DAYS (default 90, 0 = keep forever).
//
// Hand-written: `yarn db:migrate` cannot generate (see CLAUDE.md). Mirrors
// shared/src/schema/node-metric.ts — keep the two in sync by hand.
//
// Like StorageClaimAudit, node identity is plain text, not a relation — nodes
// are Garage entities with no PB counterpart, and samples must survive layout
// changes. All write rules are null: the cron writes via the JSVM layer, which
// bypasses collection rules, so from the API the history is read-only.
//
// PocketBase number fields cannot hold null (unset reads back as 0), so
// "no reading" has explicit conventions consumers must honor:
//   - `node_stats_ok` gates the two resync fields (a failed GetNodeStatistics
//     call must not chart as "queue dropped to 0").
//   - Partition fields: a real partition always has total > 0, so
//     `*_total_bytes === 0` means "no partition data" (e.g. a gateway node).
//
// The two indexes serve the two hot queries: per-node latest/series reads
// (`node_id, created`) and the history range scan + retention prune
// (`created`).
//
migrate((app) => {
  const collection = new Collection({
    "id": "pb_nodemetrics4x7z",
    "name": "NodeMetrics",
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
      "name": "node_id",
      "id": "textnmnodeid01",
      "type": "text",
      "required": true,
      "min": 1,
      "max": 128,
    },
    {
      "name": "node_hostname",
      "id": "textnmhostnm01",
      "type": "text",
      "required": false,
      "max": 255,
    },
    {
      "name": "node_zone",
      "id": "textnmzone0001",
      "type": "text",
      "required": false,
      "max": 64,
    },
    {
      // A required bool in PB means "must be true" — keep these false.
      "name": "is_up",
      "id": "boolnmisup0001",
      "type": "bool",
      "required": false,
    },
    {
      "name": "node_stats_ok",
      "id": "boolnmstats001",
      "type": "bool",
      "required": false,
    },
    {
      "name": "resync_queue_length",
      "id": "numbernmrsq00001",
      "type": "number",
      "required": false,
      "min": 0,
      "max": 9007199254740991,
      "onlyInt": true,
    },
    {
      "name": "resync_errored_blocks",
      "id": "numbernmrse00001",
      "type": "number",
      "required": false,
      "min": 0,
      "max": 9007199254740991,
      "onlyInt": true,
    },
    {
      "name": "data_total_bytes",
      "id": "numbernmdtb00001",
      "type": "number",
      "required": false,
      "min": 0,
      "max": 9007199254740991,
      "onlyInt": true,
    },
    {
      "name": "data_available_bytes",
      "id": "numbernmdab00001",
      "type": "number",
      "required": false,
      "min": 0,
      "max": 9007199254740991,
      "onlyInt": true,
    },
    {
      "name": "meta_total_bytes",
      "id": "numbernmmtb00001",
      "type": "number",
      "required": false,
      "min": 0,
      "max": 9007199254740991,
      "onlyInt": true,
    },
    {
      "name": "meta_available_bytes",
      "id": "numbernmmab00001",
      "type": "number",
      "required": false,
      "min": 0,
      "max": 9007199254740991,
      "onlyInt": true,
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
    "CREATE INDEX `idx_nodemetrics_node_created` ON `NodeMetrics` (`node_id`, `created`)",
    "CREATE INDEX `idx_nodemetrics_created` ON `NodeMetrics` (`created`)",
  ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_nodemetrics4x7z") // NodeMetrics;
  return app.delete(collection);
});
