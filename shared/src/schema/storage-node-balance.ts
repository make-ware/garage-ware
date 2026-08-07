import {
  baseSchema,
  DateField,
  defineCollection,
  NumberField,
  RelationField,
  TextField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

/**
 * One user's rolled-up claim on one node — the sum of their StorageClaims
 * entries for that pair, maintained by the hooks in pb_hooks/main.pb.js.
 *
 * This exists because the ledger only grows. Every per-user sum used to read a
 * single page of it (200–1000 rows), which is a silent wrong answer waiting on
 * row count, and those sums back `assertClaimDeltaAllowed` — the guard on every
 * claim mutation. Reading a roll-up instead makes the cost O(nodes).
 *
 * Why per (user, node) and not a single net-granted figure per user: a claim on
 * a node that has left the cluster layout must count as zero, and a PocketBase
 * hook cannot reach Garage to find out which nodes those are. Keeping the
 * breakdown lets the layout filter stay where it can be applied correctly —
 * at read time, in the webapp. See `computeSummaryFromBalances`.
 *
 * Two things here are the *opposite* of StorageClaimAudit, deliberately:
 *   - `user` is a cascading relation, not text. This is a cache; when the user
 *     goes, their claims cascade and their balance should go with them. An
 *     audit row must outlive its subject; a cache must not.
 *   - The (user, node_id) index IS unique. StorageClaims is non-unique because
 *     it stores entries; this stores the roll-up, so one row per pair is the
 *     invariant — and letting PocketBase enforce it means a hook bug fails
 *     loudly instead of quietly duplicating.
 */
export const StorageNodeBalanceSchema = z
  .object({
    user: RelationField({ collection: 'Users', cascadeDelete: true }),
    node_id: TextField().min(1).max(128),
    /** Signed sum of this pair's ledger entries, in logical (post-replication) GB. */
    claimed_gb: NumberField().default(0),
    /** How many ledger entries make up the sum. Handy for spotting a stuck hook. */
    entry_count: NumberField({ min: 0 }).int().default(0),
    node_hostname: TextField({ max: 255 }).optional(),
    node_zone: TextField({ max: 64 }).optional(),
    /** Last full rebuild that touched this row. */
    recomputed_at: DateField().optional(),
  })
  .extend(baseSchema);

export const StorageNodeBalanceInputSchema = z.object({
  user: z.string().min(1),
  node_id: z.string().min(1).max(128),
  claimed_gb: z.number().default(0),
  entry_count: z.number().int().min(0).default(0),
  node_hostname: z.string().max(255).optional(),
  node_zone: z.string().max(64).optional(),
  recomputed_at: z.string().optional(),
});

export const StorageNodeBalanceCollection = defineCollection({
  collectionName: 'StorageNodeBalances',
  schema: StorageNodeBalanceSchema,
  permissions: {
    listRule:
      'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    viewRule:
      'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    // Derived data: only the hooks write it, through the Go/JSVM layer, which
    // bypasses collection rules. Locking the API surface keeps the cache from
    // being edited into disagreeing with the ledger it summarises.
    createRule: null,
    updateRule: null,
    deleteRule: null,
  },
  indexes: [
    // Unique on purpose — exactly one roll-up per (user, node).
    'CREATE UNIQUE INDEX `idx_nodebalance_user_node` ON `StorageNodeBalances` (`user`, `node_id`)',
    'CREATE INDEX `idx_nodebalance_node` ON `StorageNodeBalances` (`node_id`)',
  ],
});

export default StorageNodeBalanceCollection;

export type StorageNodeBalance = z.infer<typeof StorageNodeBalanceSchema>;
export type StorageNodeBalanceInput = z.infer<
  typeof StorageNodeBalanceInputSchema
>;
