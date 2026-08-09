import {
  baseSchema,
  DateField,
  defineCollection,
  JSONField,
  TextField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

/**
 * Last-known Garage cluster responses, one row per kind of read.
 *
 * Every dashboard load used to make its own live admin-API round trips — the
 * layout three times over, plus a cluster-wide status fan-out — and each of
 * those waits on every peer answering. None of it is realtime data: a layout
 * changes when an operator changes it. So the display paths read through this
 * table instead (see webapp/src/lib/garage/cached.ts), serving what is stored
 * and refreshing it behind the response when it goes stale.
 *
 * This is the third deliberate exception to "PocketBase does not mirror Garage
 * state", after the Buckets usage cache and NodeMetrics — and the narrowest
 * kind: a cache with a TTL, never a source of truth. Two consequences follow
 * and neither is optional:
 *
 *   - **Validators must not read it.** Every storage invariant is enforced
 *     against the layout, and a stale layout must never decide whether capacity
 *     exists. Claim, transfer, bucket-quota and invite-settlement paths keep
 *     fetching live. Only GET/display handlers read through here.
 *   - **`payload` is re-parsed on every read** through the zod schemas in
 *     lib/garage/schemas.ts. Garage v2 is documented as an early implementation
 *     that may change, so a row written by an older shape must be treated as a
 *     miss rather than trusted.
 *
 * `fetched_at` is when the payload came back from Garage, which is not the
 * autodate `updated` — that moves on any write, including one that only
 * re-confirms what was already stored.
 */
export const GarageClusterCacheSchema = z
  .object({
    /**
     * Which read this row holds: 'layout' | 'status' | 'health' |
     * 'replication_factor'. The values live beside the TTLs in
     * webapp/src/lib/garage/cached.ts — the schema only cares that it is a
     * short unique string.
     */
    key: TextField().min(1).max(64),
    /**
     * The raw Garage response body. `replication_factor` stores
     * `{ replicationFactor: n }` rather than a bare number, so every payload is
     * an object and the column has one shape.
     */
    payload: JSONField(),
    /** When Garage answered — the age the TTL is measured against. */
    fetched_at: DateField().optional(),
  })
  .extend(baseSchema);

export const GarageClusterCacheInputSchema = z.object({
  key: z.string().min(1).max(64),
  payload: z.record(z.string(), z.any()),
  fetched_at: z.string().optional(),
});

export const GarageClusterCacheCollection = defineCollection({
  collectionName: 'GarageClusterCache',
  schema: GarageClusterCacheSchema,
  permissions: {
    // Every rule null: this is a server-side implementation detail, read and
    // written only through the superuser client, which bypasses collection
    // rules. Not merely tidy — a raw layout/status payload carries node
    // addresses and hostnames that the browser is never handed today, and
    // opening a read rule here would leak them.
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  },
  indexes: [
    // Unique on purpose — one row per kind of read, and the natural-key upsert
    // in the mutator relies on the DB rejecting a concurrent second create.
    'CREATE UNIQUE INDEX `idx_garageclustercache_key` ON `GarageClusterCache` (`key`)',
  ],
});

export default GarageClusterCacheCollection;

export type GarageClusterCache = z.infer<typeof GarageClusterCacheSchema>;
export type GarageClusterCacheInput = z.infer<
  typeof GarageClusterCacheInputSchema
>;
