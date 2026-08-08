import {
  baseSchema,
  defineCollection,
  NumberField,
  SelectField,
  TextField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

/** What happened to the source StorageClaims row. */
export const CLAIM_AUDIT_ACTIONS = ['create', 'update', 'delete'] as const;

/** Who performed it, resolved from the authenticated record on the request. */
export const CLAIM_AUDIT_ACTOR_TYPES = ['user', 'superuser', 'system'] as const;

/**
 * How the change reached the database. `api` is any write that arrived over
 * the PocketBase API (our route handlers, the PB admin UI, a direct SDK call);
 * `cascade` is a claim removed as a side effect of deleting its owning user,
 * which never produces a per-row request.
 */
export const CLAIM_AUDIT_SOURCES = ['api', 'cascade'] as const;

/**
 * An immutable record of one mutation to the StorageClaims ledger.
 *
 * StorageClaims is itself append-only, but it only ever holds the rows that
 * currently exist: a PATCH rewrites an entry's amount and a DELETE removes it
 * outright, and neither leaves a trace of who did it or what it was before.
 * This collection is that trace, written by the hooks in
 * pocketbase/pb_hooks/main.pb.js.
 *
 * Every reference here is a plain TextField rather than a RelationField, and
 * that is deliberate. `StorageClaims.user` cascades from Users, so deleting a
 * user erases their claims — a relation would erase the audit trail along with
 * them, at exactly the moment it is worth having. `claim_id` is likewise a
 * dangling id by design: it still points at the row that was deleted.
 *
 * Sign conventions, chosen so `delta_gb` matches the `deltaGb` handed to
 * `assertClaimDeltaAllowed`:
 *   create → previous_gb = 0,      new_gb = delta_gb = amount
 *   update → previous_gb = before, new_gb = after, delta_gb = after - before
 *   delete → previous_gb = amount, new_gb = 0,     delta_gb = -amount
 */
export const StorageClaimAuditSchema = z
  .object({
    action: SelectField(CLAIM_AUDIT_ACTIONS),
    /** Source StorageClaims row id. Intentionally dangling after a delete. */
    claim_id: TextField({ max: 32 }).optional(),
    /** Target user id — the user whose claim moved. */
    user_id: TextField().min(1).max(32),
    /** Snapshot, so the trail stays readable once the user is gone. */
    user_email: TextField({ max: 255 }).optional(),
    node_id: TextField().min(1).max(128),
    node_hostname: TextField({ max: 255 }).optional(),
    node_zone: TextField({ max: 64 }).optional(),
    previous_gb: NumberField().default(0),
    new_gb: NumberField().default(0),
    delta_gb: NumberField().default(0),
    /** The claim's note as it stood after the change. */
    note: TextField({ max: 500 }).optional(),
    actor_id: TextField({ max: 32 }).optional(),
    actor_email: TextField({ max: 255 }).optional(),
    actor_type: SelectField(CLAIM_AUDIT_ACTOR_TYPES).optional(),
    source: SelectField(CLAIM_AUDIT_SOURCES).optional(),
  })
  .extend(baseSchema);

export const StorageClaimAuditInputSchema = z.object({
  action: z.enum(CLAIM_AUDIT_ACTIONS),
  claim_id: z.string().max(32).optional(),
  user_id: z.string().min(1).max(32),
  user_email: z.string().max(255).optional(),
  node_id: z.string().min(1).max(128),
  node_hostname: z.string().max(255).optional(),
  node_zone: z.string().max(64).optional(),
  previous_gb: z.number().default(0),
  new_gb: z.number().default(0),
  delta_gb: z.number().default(0),
  note: z.string().max(500).optional(),
  actor_id: z.string().max(32).optional(),
  actor_email: z.string().max(255).optional(),
  actor_type: z.enum(CLAIM_AUDIT_ACTOR_TYPES).optional(),
  source: z.enum(CLAIM_AUDIT_SOURCES).optional(),
});

export const StorageClaimAuditCollection = defineCollection({
  collectionName: 'StorageClaimAudit',
  schema: StorageClaimAuditSchema,
  permissions: {
    // Admins read the trail; nobody writes it over the API. The hooks write
    // via the Go/JSVM layer (`e.app.save`), which bypasses collection rules,
    // so locking all three write rules costs us nothing and makes the log
    // genuinely append-only from the outside.
    listRule: '@collection.Admins.user ?= @request.auth.id',
    viewRule: '@collection.Admins.user ?= @request.auth.id',
    createRule: null,
    updateRule: null,
    deleteRule: null,
  },
  indexes: [
    'CREATE INDEX `idx_claimaudit_user` ON `StorageClaimAudit` (`user_id`)',
    'CREATE INDEX `idx_claimaudit_node` ON `StorageClaimAudit` (`node_id`)',
    'CREATE INDEX `idx_claimaudit_claim` ON `StorageClaimAudit` (`claim_id`)',
    'CREATE INDEX `idx_claimaudit_created` ON `StorageClaimAudit` (`created`)',
  ],
});

export default StorageClaimAuditCollection;

export type ClaimAuditAction = (typeof CLAIM_AUDIT_ACTIONS)[number];
export type ClaimAuditActorType = (typeof CLAIM_AUDIT_ACTOR_TYPES)[number];
export type ClaimAuditSource = (typeof CLAIM_AUDIT_SOURCES)[number];
export type StorageClaimAudit = z.infer<typeof StorageClaimAuditSchema>;
export type StorageClaimAuditInput = z.infer<
  typeof StorageClaimAuditInputSchema
>;
