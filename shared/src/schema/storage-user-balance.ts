import {
  baseSchema,
  DateField,
  defineCollection,
  NumberField,
  RelationField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

/**
 * The node-agnostic half of a user's storage position: transfers in and out,
 * and how much their buckets already reserve. Maintained by the hooks in
 * pb_hooks/main.pb.js alongside StorageNodeBalances.
 *
 * Same motivation as the per-node roll-up — `listSentByUser` and
 * `sumAllocatedGb` each read one page (500 / 1000 rows), which under-counts
 * silently once a user outgrows it.
 *
 * `claims_gb` is stored here too, but read the comment on it before using it:
 * it is NOT the granted figure.
 */
export const StorageUserBalanceSchema = z
  .object({
    user: RelationField({ collection: 'Users', cascadeDelete: true }),
    /**
     * Unfiltered sum of the user's claims across every node, including nodes
     * that have left the layout.
     *
     * This is a drift-detection aid, NOT the user's granted storage — a claim
     * on a decommissioned node backs nothing. The granted figure comes from
     * summing StorageNodeBalances filtered by the live layout. Reaching for
     * this because it is the convenient single number is exactly the bug the
     * per-node breakdown exists to prevent.
     */
    claims_gb: NumberField().default(0),
    sent_gb: NumberField({ min: 0 }).default(0),
    received_gb: NumberField({ min: 0 }).default(0),
    allocated_gb: NumberField({ min: 0 }).default(0),
    /** Last full rebuild that touched this row. */
    recomputed_at: DateField().optional(),
    /**
     * How much the last rebuild had to correct. Non-zero means the incremental
     * hooks missed a write path — a bug to chase, not routine maintenance, so
     * it is recorded rather than silently fixed.
     */
    last_drift_gb: NumberField().default(0),
  })
  .extend(baseSchema);

export const StorageUserBalanceInputSchema = z.object({
  user: z.string().min(1),
  claims_gb: z.number().default(0),
  sent_gb: z.number().min(0).default(0),
  received_gb: z.number().min(0).default(0),
  allocated_gb: z.number().min(0).default(0),
  recomputed_at: z.string().optional(),
  last_drift_gb: z.number().default(0),
});

export const StorageUserBalanceCollection = defineCollection({
  collectionName: 'StorageUserBalances',
  schema: StorageUserBalanceSchema,
  permissions: {
    listRule:
      'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    viewRule:
      'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    createRule: null,
    updateRule: null,
    deleteRule: null,
  },
  indexes: [
    'CREATE UNIQUE INDEX `idx_userbalance_user` ON `StorageUserBalances` (`user`)',
  ],
});

export default StorageUserBalanceCollection;

export type StorageUserBalance = z.infer<typeof StorageUserBalanceSchema>;
export type StorageUserBalanceInput = z.infer<
  typeof StorageUserBalanceInputSchema
>;
