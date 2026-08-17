import {
  baseSchema,
  defineCollection,
  NumberField,
  RelationField,
  TextField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

/**
 * A single append-only ledger entry: a signed adjustment to one user's claim
 * on one Garage node, in logical (post-replication) GB.
 *
 * Rows are entries, not state. A user's effective claim on a node is the SUM
 * of their entries for that node, and their total claim is the sum across all
 * nodes. `quota_gb` is therefore deliberately unbounded below — a negative
 * entry reclaims previously granted space (e.g. a node downgrade), and the
 * grant history stays auditable instead of being overwritten.
 */
export const StorageClaimSchema = z
  .object({
    user: RelationField({ collection: 'Users', cascadeDelete: true }),
    node_id: TextField().min(1).max(128),
    node_hostname: TextField({ max: 255 }).optional(),
    node_zone: TextField({ max: 64 }).optional(),
    quota_gb: NumberField().default(0),
    note: TextField({ max: 500 }).optional(),
  })
  .extend(baseSchema);

export const StorageClaimInputSchema = z.object({
  user: z.string().min(1),
  node_id: z.string().min(1).max(128),
  node_hostname: z.string().max(255).optional(),
  node_zone: z.string().max(64).optional(),
  quota_gb: z.number().default(0),
  note: z.string().max(500).optional(),
});

export const StorageClaimCollection = defineCollection({
  collectionName: 'StorageClaims',
  schema: StorageClaimSchema,
  permissions: {
    listRule:
      'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    viewRule:
      'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    // All three null. Every claim write now goes through
    // /next-api/garage/claims, which authenticates as a superuser and passes
    // the real actor in request headers (see pb_hooks/lib/claim-audit.js).
    // Locking them is not cosmetic: it is what makes the Route-Handler funnel
    // genuine ENFORCEMENT for this collection rather than convention, so
    // neither an admin nor a node owner can skip assertClaimDeltaAllowed with
    // a direct SDK call from a browser.
    createRule: null,
    updateRule: null,
    deleteRule: null,
  },
  indexes: [
    // Deliberately NOT unique: many ledger entries per (user, node).
    'CREATE INDEX `idx_storageclaims_user_node` ON `StorageClaims` (`user`, `node_id`)',
    'CREATE INDEX `idx_storageclaims_user` ON `StorageClaims` (`user`)',
    'CREATE INDEX `idx_storageclaims_node` ON `StorageClaims` (`node_id`)',
  ],
});

export default StorageClaimCollection;

export type StorageClaim = z.infer<typeof StorageClaimSchema>;
export type StorageClaimInput = z.infer<typeof StorageClaimInputSchema>;
