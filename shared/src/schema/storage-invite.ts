import {
  baseSchema,
  defineCollection,
  DateField,
  NumberField,
  RelationField,
  SelectField,
  TextField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

/**
 * Where an invite is in its life.
 *
 * `pending` is the only state that promises anything; `claimed` and `failed`
 * are kept rather than deleted so a sender can see what became of a handoff
 * they made weeks ago. Cancelling is a delete, matching how a transfer is
 * "returned" — see StorageTransfers.
 */
export const STORAGE_INVITE_STATUSES = [
  'pending',
  'claimed',
  'failed',
] as const;

/**
 * Storage promised to an email address that has no account yet.
 *
 * A StorageTransfer needs two Users rows, so there was previously no way to
 * hand capacity to someone who has not signed up. An invite is the same
 * handoff held in escrow: it names the recipient by email, and the claim
 * endpoint turns it into a real transfer once that email owns an account.
 *
 * `to_email` is a plain TextField, not a relation — the whole point is that
 * the row exists before the user does. It is matched case-insensitively at
 * claim time, so it is stored lowercased.
 *
 * An invite is a *promise*, not a reservation. Only the transfer it becomes
 * moves capacity, and the balance hooks therefore ignore this collection
 * entirely. The consequence is that a sender who invites and then fills their
 * buckets can leave a pending invite unpayable; the claim endpoint re-checks
 * the sender's position and marks such an invite `failed` rather than breaking
 * the "may only give away unallocated capacity" invariant.
 */
export const StorageInviteSchema = z
  .object({
    from_user: RelationField({ collection: 'Users', cascadeDelete: true }),
    /** Lowercased. The recipient has no Users row when this is written. */
    to_email: TextField({ max: 255 }).min(1),
    quota_gb: NumberField({ min: 0.001 }),
    note: TextField({ max: 500 }).optional(),
    status: SelectField(STORAGE_INVITE_STATUSES).default('pending'),
    /** Set when the invite resolves, either way. */
    settled_at: DateField().optional(),
    /** The StorageTransfers row a claimed invite became. */
    transfer_id: TextField({ max: 32 }).optional(),
    /** Why a `failed` invite could not be paid, shown to the sender. */
    failure_reason: TextField({ max: 500 }).optional(),
  })
  .extend(baseSchema);

export const StorageInviteInputSchema = z.object({
  from_user: z.string().min(1),
  to_email: z.string().email().max(255),
  quota_gb: z.number().min(0.001),
  note: z.string().max(500).optional(),
  status: z.enum(STORAGE_INVITE_STATUSES).optional(),
  settled_at: z.string().optional(),
  transfer_id: z.string().max(32).optional(),
  failure_reason: z.string().max(500).optional(),
});

export const StorageInviteCollection = defineCollection({
  collectionName: 'StorageInvites',
  schema: StorageInviteSchema,
  permissions: {
    // The invitee cannot be in these rules: until they claim, they have no
    // account to match on, and afterwards the invite is the sender's record of
    // what they gave. The claim endpoint reads across users as a superuser.
    listRule:
      'from_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    viewRule:
      'from_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    createRule:
      'from_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    // Status only ever moves under the claim endpoint, which authenticates as
    // a superuser and so bypasses this rule. Nothing else may rewrite a promise.
    updateRule: null,
    // Cancelling an invite is deleting it, exactly as returning a transfer is.
    deleteRule:
      'from_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
  },
  indexes: [
    'CREATE INDEX `idx_storageinvites_from_user` ON `StorageInvites` (`from_user`)',
    // The claim path looks invites up by address, so this is the hot one.
    'CREATE INDEX `idx_storageinvites_to_email` ON `StorageInvites` (`to_email`)',
  ],
});

export default StorageInviteCollection;

export type StorageInvite = z.infer<typeof StorageInviteSchema>;
export type StorageInviteInput = z.infer<typeof StorageInviteInputSchema>;
export type StorageInviteStatus = (typeof STORAGE_INVITE_STATUSES)[number];
