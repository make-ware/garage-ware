/// <reference path="../pb_data/types.d.ts" />
//
// Widens NodeMetrics list/view from admin-only to any signed-in user, for the
// cluster map's per-node "latest sample" panel, which reads the collection
// directly from the browser. Same reasoning as the /next-api node-metrics
// history route: cluster health is what a user's own storage rides on, and a
// row carries node hostnames, zones, and fill levels but nothing about who
// stores what. Write rules stay null — the scrape cron writes via the JSVM,
// which bypasses collection rules.
//
// Hand-written; `yarn db:migrate` cannot generate against this repo's
// migration history (see 1786200000_updated_Buckets.js for why).
migrate((app) => {
  const collection_NodeMetrics_widen_read = app.findCollectionByNameOrId("pb_nodemetrics4x7z") // NodeMetrics;

  collection_NodeMetrics_widen_read.listRule = "@request.auth.id != ''";
  collection_NodeMetrics_widen_read.viewRule = "@request.auth.id != ''";

  return app.save(collection_NodeMetrics_widen_read);
}, (app) => {
  const collection_NodeMetrics_revert_widen_read = app.findCollectionByNameOrId("pb_nodemetrics4x7z") // NodeMetrics;

  collection_NodeMetrics_revert_widen_read.listRule = "@collection.Admins.user ?= @request.auth.id";
  collection_NodeMetrics_revert_widen_read.viewRule = "@collection.Admins.user ?= @request.auth.id";

  return app.save(collection_NodeMetrics_revert_widen_read);
});
