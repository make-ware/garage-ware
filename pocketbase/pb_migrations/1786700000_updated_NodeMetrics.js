/// <reference path="../pb_data/types.d.ts" />
//
// Adds the four columns behind "detect nodes that are missing data" (see
// webapp/src/lib/metrics/data-coverage.ts):
//
//   layout_ok            — GetClusterLayout succeeded for this scrape. The new
//                          gate, exactly parallel to node_stats_ok.
//   stored_partitions    — roles[].storedPartitions for this node. Gated by
//                          layout_ok, under which 0 is a REAL reading ("no
//                          role in the current layout" — a gateway, or a node
//                          draining out of an older layout). Without the gate
//                          a cluster-wide layout failure would write 0 for
//                          every node and read back forever as "all gateways,
//                          nothing to judge".
//   partition_size_bytes — layout.partitionSize. Cluster-wide, denormalized
//                          per row so a historical sample stays interpretable
//                          after a layout change. Gated by layout_ok.
//   rc_entries           — blockManagerStats.rcEntries, i.e. the blocks this
//                          node's metadata says it is responsible for. Same
//                          call as the resync counters, so it rides the
//                          existing node_stats_ok gate; no new gate needed.
//
// No backfill: existing rows read layout_ok = false, which is the truth —
// those samples carry no layout reading, and the chart shows a gap before this
// migration rather than a fabricated zero.
//
// Hand-written rather than generated. `yarn db:migrate` cannot run against
// this repo's migration history (see 1786200000_updated_Buckets.js for why).
// Mirrors shared/src/schema/node-metric.ts — keep the two in sync by hand.
// The `onlyInt` / `max` pair is set up front, as on the columns
// 1786400000_created_NodeMetrics.js already carries, so these do not need the
// follow-up migration the generator's omission forced elsewhere.
migrate((app) => {
  const collection_NodeMetrics_add_coverage = app.findCollectionByNameOrId("pb_nodemetrics4x7z") // NodeMetrics;

  collection_NodeMetrics_add_coverage.fields.add(new BoolField({
    // A required bool in PB means "must be true" — keep this false.
    "name": "layout_ok",
    "id": "boolnmlayout01",
    "required": false
  }));

  collection_NodeMetrics_add_coverage.fields.add(new NumberField({
    "name": "stored_partitions",
    "id": "numbernmspt00001",
    "required": false,
    "min": 0,
    "max": 9007199254740991,
    "onlyInt": true
  }));

  collection_NodeMetrics_add_coverage.fields.add(new NumberField({
    "name": "partition_size_bytes",
    "id": "numbernmpsb00001",
    "required": false,
    "min": 0,
    "max": 9007199254740991,
    "onlyInt": true
  }));

  collection_NodeMetrics_add_coverage.fields.add(new NumberField({
    "name": "rc_entries",
    "id": "numbernmrce00001",
    "required": false,
    "min": 0,
    "max": 9007199254740991,
    "onlyInt": true
  }));

  return app.save(collection_NodeMetrics_add_coverage);
}, (app) => {
  const collection_NodeMetrics_revert_coverage = app.findCollectionByNameOrId("pb_nodemetrics4x7z") // NodeMetrics;

  collection_NodeMetrics_revert_coverage.fields.removeByName("layout_ok");
  collection_NodeMetrics_revert_coverage.fields.removeByName("stored_partitions");
  collection_NodeMetrics_revert_coverage.fields.removeByName("partition_size_bytes");
  collection_NodeMetrics_revert_coverage.fields.removeByName("rc_entries");

  return app.save(collection_NodeMetrics_revert_coverage);
});
