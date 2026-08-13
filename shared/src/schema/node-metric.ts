import {
  BoolField,
  baseSchema,
  defineCollection,
  NumberField,
  TextField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

/**
 * One per-node sample of cluster health, appended every 15 minutes by the
 * `node-metrics-scrape` cron in pocketbase/pb_hooks/main.pb.js (scraper in
 * pb_hooks/lib/node-metrics.js). The row's timestamp is the autodate
 * `created`; retention is enforced by the same cron
 * (NODE_METRICS_RETENTION_DAYS, default 90, 0 = keep forever).
 *
 * Node identity is a plain TextField, not a relation — nodes are Garage
 * entities with no PB counterpart, and samples must outlive layout changes.
 *
 * PocketBase number fields cannot be null (unset reads back as 0), so
 * "no reading" needs explicit conventions — chart code must honor them:
 *   - `node_stats_ok` gates `resync_queue_length` / `resync_errored_blocks`
 *     and `rc_entries` (all three come from the same GetNodeStatistics call,
 *     so they ride one gate). A failed call must not chart as "queue dropped
 *     to 0".
 *   - `layout_ok` gates `stored_partitions` / `partition_size_bytes` (both
 *     come from GetClusterLayout). Under that gate, `stored_partitions === 0`
 *     is a *real reading* — "this node holds no partitions", i.e. a gateway,
 *     or a node draining out of an older layout — which is exactly why the
 *     gate has to exist: without it a cluster-wide layout failure would write
 *     0 for every node and read back, forever, as "all gateways, nothing to
 *     judge".
 *   - `role_ok` gates `role_capacity_bytes` / `node_tags` / `layout_version`.
 *     It reads "this row was written by a scraper that records the layout
 *     role fields", and is set whenever `layout_ok` is — *including* for a
 *     node with no role, whose capacity is then a genuine 0. Rows written
 *     before those columns existed read false, which is what stops the first
 *     scrape after the upgrade from seeing every storage node go
 *     `0 → 16 TB` and emitting a spurious ClusterEvents row for each. See
 *     pocketbase/pb_hooks/lib/cluster-events.js.
 *   - Partition fields carry their own sentinel: a real partition always has
 *     total > 0, so `*_total_bytes === 0` means "no partition data" (e.g. a
 *     gateway node). "Used" is derived: total − available.
 *
 * `stored_partitions` and `partition_size_bytes` are what makes
 * webapp/src/lib/metrics/data-coverage.ts possible: a stored partition holds
 * one full replica of that partition's data whatever the reason it was
 * assigned, so `usedBytes / stored_partitions` is near-uniform across healthy
 * storage nodes and a node well below its peers is a node missing data.
 * `partition_size_bytes` is cluster-wide but denormalized onto every row so a
 * historical sample stays interpretable after a layout change.
 *
 * `rc_entries` is the count of blocks the node's *metadata* says it is
 * responsible for. Metadata converges on the fast table-sync path while block
 * data moves on the slow resync path, so "rc normal, bytes low" is the
 * fingerprint of a wiped data drive with intact metadata — it is what
 * separates missing data from still rebuilding.
 *
 * The scrape deliberately covers only what the central admin API exposes.
 * Throughput (bytes read/written) and API request/error counters live only on
 * each node's own Prometheus /metrics endpoint behind a Metrics-scoped token;
 * if that scope is ever revisited, the fields land here via a plain additive
 * migration.
 */
export const NodeMetricSchema = z
  .object({
    node_id: TextField().min(1).max(128),
    node_hostname: TextField({ max: 255 }).optional(),
    /** "" when the node has no assigned role. */
    node_zone: TextField({ max: 64 }).optional(),
    /** Was the node connected to the cluster at sample time. */
    is_up: BoolField(),
    /** GetNodeStatistics succeeded for this node — gates the resync fields. */
    node_stats_ok: BoolField(),
    resync_queue_length: NumberField({ min: 0 }).int().default(0),
    resync_errored_blocks: NumberField({ min: 0 }).int().default(0),
    /** Blocks this node's metadata holds a refcount for (gated by node_stats_ok). */
    rc_entries: NumberField({ min: 0 }).int().default(0),
    /** GetClusterLayout succeeded — gates the two layout fields below. */
    layout_ok: BoolField(),
    /** Partitions the layout assigns this node; 0 under the gate is a reading. */
    stored_partitions: NumberField({ min: 0 }).int().default(0),
    /** Cluster-wide bytes per partition, denormalized (gated by layout_ok). */
    partition_size_bytes: NumberField({ min: 0 }).int().default(0),
    /** This row carries the layout role fields below — see the docblock. */
    role_ok: BoolField(),
    /** Capacity the layout assigns this node; 0 = gateway or no role. */
    role_capacity_bytes: NumberField({ min: 0 }).int().default(0),
    /** The role's tags, comma-joined — carries the `name:` tag, so a rename
     * shows up as a change (gated by role_ok). */
    node_tags: TextField({ max: 500 }).optional(),
    /** Cluster layout version at sample time, denormalized (gated by role_ok). */
    layout_version: NumberField({ min: 0 }).int().default(0),
    /** The node's reported Garage version; "" = unknown. Not gated — it comes
     * from GetClusterStatus, whose failure aborts the whole scrape. */
    garage_version: TextField({ max: 64 }).optional(),
    data_total_bytes: NumberField({ min: 0 }).int().default(0),
    data_available_bytes: NumberField({ min: 0 }).int().default(0),
    meta_total_bytes: NumberField({ min: 0 }).int().default(0),
    meta_available_bytes: NumberField({ min: 0 }).int().default(0),
  })
  .extend(baseSchema);

export const NodeMetricInputSchema = z.object({
  node_id: z.string().min(1).max(128),
  node_hostname: z.string().max(255).optional(),
  node_zone: z.string().max(64).optional(),
  is_up: z.boolean(),
  node_stats_ok: z.boolean(),
  resync_queue_length: z.number().int().min(0).default(0),
  resync_errored_blocks: z.number().int().min(0).default(0),
  rc_entries: z.number().int().min(0).default(0),
  layout_ok: z.boolean(),
  stored_partitions: z.number().int().min(0).default(0),
  partition_size_bytes: z.number().int().min(0).default(0),
  role_ok: z.boolean(),
  role_capacity_bytes: z.number().int().min(0).default(0),
  node_tags: z.string().max(500).optional(),
  layout_version: z.number().int().min(0).default(0),
  garage_version: z.string().max(64).optional(),
  data_total_bytes: z.number().int().min(0).default(0),
  data_available_bytes: z.number().int().min(0).default(0),
  meta_total_bytes: z.number().int().min(0).default(0),
  meta_available_bytes: z.number().int().min(0).default(0),
});

export const NodeMetricCollection = defineCollection({
  collectionName: 'NodeMetrics',
  schema: NodeMetricSchema,
  permissions: {
    // Any signed-in user reads the history — cluster health is what a user's
    // own storage rides on, and a row carries node hostnames, zones, and fill
    // levels but nothing about who stores what. Nobody writes over the API;
    // the cron writes via the JSVM (`app.save`), which bypasses collection
    // rules.
    listRule: "@request.auth.id != ''",
    viewRule: "@request.auth.id != ''",
    createRule: null,
    updateRule: null,
    deleteRule: null,
  },
  indexes: [
    'CREATE INDEX `idx_nodemetrics_node_created` ON `NodeMetrics` (`node_id`, `created`)',
    'CREATE INDEX `idx_nodemetrics_created` ON `NodeMetrics` (`created`)',
  ],
});

export default NodeMetricCollection;

export type NodeMetric = z.infer<typeof NodeMetricSchema>;
export type NodeMetricInput = z.infer<typeof NodeMetricInputSchema>;
