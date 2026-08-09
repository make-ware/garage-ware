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
 *   - `node_stats_ok` gates `resync_queue_length` / `resync_errored_blocks`.
 *     A failed GetNodeStatistics call must not chart as "queue dropped to 0".
 *   - Partition fields carry their own sentinel: a real partition always has
 *     total > 0, so `*_total_bytes === 0` means "no partition data" (e.g. a
 *     gateway node). "Used" is derived: total − available.
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
