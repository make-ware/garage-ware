import 'server-only';
import { z } from 'zod';
import { multiResponseSchema } from './multi-node';

// ── Cluster ────────────────────────────────────────────────────────────────

export const ClusterHealthSchema = z.object({
  status: z.string(),
  knownNodes: z.number().int().nonnegative(),
  connectedNodes: z.number().int().nonnegative(),
  storageNodes: z.number().int().nonnegative(),
  storageNodesUp: z.number().int().nonnegative(),
  partitions: z.number().int().nonnegative(),
  partitionsQuorum: z.number().int().nonnegative(),
  partitionsAllOk: z.number().int().nonnegative(),
});
export type ClusterHealth = z.infer<typeof ClusterHealthSchema>;

const FreeSpaceSchema = z.object({
  available: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const NodeAssignedRoleSchema = z.object({
  zone: z.string(),
  tags: z.array(z.string()),
  capacity: z.number().int().nullable().optional(),
});

const NodeStatusSchema = z.object({
  id: z.string(),
  isUp: z.boolean(),
  draining: z.boolean(),
  addr: z.string().nullable().optional(),
  hostname: z.string().nullable().optional(),
  garageVersion: z.string().nullable().optional(),
  lastSeenSecsAgo: z.number().int().nullable().optional(),
  dataPartition: FreeSpaceSchema.nullable().optional(),
  metadataPartition: FreeSpaceSchema.nullable().optional(),
  role: NodeAssignedRoleSchema.nullable().optional(),
});

export const ClusterStatusSchema = z.object({
  layoutVersion: z.number().int(),
  nodes: z.array(NodeStatusSchema),
});
export type ClusterStatus = z.infer<typeof ClusterStatusSchema>;

export const ClusterStatisticsSchema = z.object({
  freeform: z.string().optional(),
});
export type ClusterStatistics = z.infer<typeof ClusterStatisticsSchema>;

const LayoutNodeSchema = z.object({
  id: z.string(),
  zone: z.string(),
  capacity: z.number().nullable().optional(),
  tags: z.array(z.string()).optional(),
});
export const ClusterLayoutSchema = z.object({
  version: z.number().int(),
  roles: z.array(LayoutNodeSchema),
  parameters: z
    .object({
      zoneRedundancy: z.unknown().optional(),
    })
    .partial()
    .optional(),
  partitionSize: z.number().optional(),
  stagedRoleChanges: z.array(z.unknown()).optional(),
  stagedParameters: z.unknown().nullable().optional(),
});
export type ClusterLayout = z.infer<typeof ClusterLayoutSchema>;

// ── Keys ───────────────────────────────────────────────────────────────────

const KeyPermissionsSchema = z
  .object({
    createBucket: z.boolean().optional(),
  })
  .partial();

const KeyBucketAccessSchema = z.object({
  id: z.string(),
  globalAliases: z.array(z.string()).default([]),
  localAliases: z.array(z.string()).default([]),
  permissions: z
    .object({
      read: z.boolean().optional(),
      write: z.boolean().optional(),
      owner: z.boolean().optional(),
    })
    .partial(),
});

/**
 * A key as the admin API describes it — **without its secret**.
 *
 * There is deliberately no `secretAccessKey` here, and adding one back would
 * undo the boundary it exists to hold. Garage will return the secret from
 * `GetKeyInfo` on request (`showSecretKey=true`), and this schema was the reason
 * it used to reach the browser: `getKeyInfo` asked for it unconditionally and
 * `GET /next-api/garage/keys/[id]` returned the parsed result verbatim, so the
 * live secret was served to the key's owner and to every admin — while the UI
 * said secrets could never be retrieved after creation.
 *
 * The secret is now a **credential**: `POST /next-api/garage/keys/claim` accepts
 * it as proof that you own the key. Two narrow schemas may carry one, both
 * local to `keys.ts` and neither reachable from a response type — the create
 * path's one-time reveal, and the claim verifier, which turns it into a boolean
 * and never returns it.
 */
export const GarageKeySchema = z.object({
  accessKeyId: z.string(),
  name: z.string().optional(),
  permissions: KeyPermissionsSchema.optional(),
  buckets: z.array(KeyBucketAccessSchema).optional(),
  expired: z.boolean().optional(),
});
export type GarageKey = z.infer<typeof GarageKeySchema>;

export const GarageKeyListItemSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  /**
   * Garage reports this for every key in one `ListKeys` call, which is what
   * lets `GET /next-api/garage/keys` show retired keys without mirroring the
   * flag into a PocketBase column.
   */
  expired: z.boolean().optional(),
});
export const GarageKeyListSchema = z.array(GarageKeyListItemSchema);
export type GarageKeyListItem = z.infer<typeof GarageKeyListItemSchema>;

// ── Buckets ────────────────────────────────────────────────────────────────

const BucketQuotasSchema = z.object({
  maxSize: z.number().nullable().optional(),
  maxObjects: z.number().nullable().optional(),
});

const BucketWebsiteSchema = z
  .object({
    enabled: z.boolean(),
    indexDocument: z.string().nullable().optional(),
    errorDocument: z.string().nullable().optional(),
  })
  .partial();

const BucketKeyAccessSchema = z.object({
  accessKeyId: z.string(),
  name: z.string().optional(),
  permissions: z
    .object({
      read: z.boolean().optional(),
      write: z.boolean().optional(),
      owner: z.boolean().optional(),
    })
    .partial(),
  bucketLocalAliases: z.array(z.string()).optional(),
});

export const GarageBucketSchema = z.object({
  id: z.string(),
  globalAliases: z.array(z.string()).default([]),
  websiteAccess: z.boolean().optional(),
  websiteConfig: BucketWebsiteSchema.nullable().optional(),
  keys: z.array(BucketKeyAccessSchema).optional(),
  // Garage lists all of these as required; they stay `.optional()` here
  // because the spec is self-declared "early stage" and a missing counter must
  // degrade rather than fail the parse. `describeBucketEmptiness` treats an
  // absent counter as "not known to be empty" so the looseness cannot become a
  // reason to delete something.
  objects: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
  unfinishedUploads: z.number().int().nonnegative().optional(),
  /** Added for the delete guard — Garage reports it, we were dropping it. */
  unfinishedMultipartUploads: z.number().int().nonnegative().optional(),
  unfinishedMultipartUploadParts: z.number().int().nonnegative().optional(),
  unfinishedMultipartUploadBytes: z.number().int().nonnegative().optional(),
  quotas: BucketQuotasSchema.optional(),
});
export type GarageBucket = z.infer<typeof GarageBucketSchema>;

export const GarageBucketListItemSchema = z.object({
  id: z.string(),
  globalAliases: z.array(z.string()).default([]),
});
export const GarageBucketListSchema = z.array(GarageBucketListItemSchema);
export type GarageBucketListItem = z.infer<typeof GarageBucketListItemSchema>;

// ── Workers & repair ───────────────────────────────────────────────────────
//
// Node-targeted endpoints (ListWorkers, LaunchRepairOperation) wrap these in
// the `{success, error}` envelope from ./multi-node.ts — that file, not this
// one, is where the envelope and its narrowing live, because it is a generic
// factory plus a normalizer rather than a wire shape.

const WorkerLastErrorSchema = z.object({
  message: z.string(),
  secsAgo: z.number().int().nonnegative(),
});

/**
 * An **untagged** union in the spec: three bare strings, or an object carrying
 * a throttle duration. There is no discriminant to switch on, so the object arm
 * is matched by shape. Nothing outside `lib/garage/` should ever see this —
 * the workers route flattens it via `describeWorkerState` so no component ends
 * up writing `typeof state === 'string'`.
 */
const WorkerStateSchema = z.union([
  z.enum(['busy', 'idle', 'done']),
  z.object({
    throttled: z.object({ durationSecs: z.number() }),
  }),
]);

export const WorkerInfoSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  state: WorkerStateSchema,
  errors: z.number().int().nonnegative(),
  consecutiveErrors: z.number().int().nonnegative(),
  /**
   * Human prose. The **only** channel carrying a scrub's last-completed time —
   * the v2.3.0 spec has no structured field for it anywhere. Parsed
   * best-effort by lib/repair/scrub-status.ts and always rendered verbatim
   * beside whatever that parse produced.
   */
  freeform: z.array(z.string()).default([]),
  lastError: WorkerLastErrorSchema.nullable().optional(),
  persistentErrors: z.number().int().nonnegative().nullable().optional(),
  progress: z.string().nullable().optional(),
  queueLength: z.number().int().nonnegative().nullable().optional(),
  tranquility: z.number().int().nullable().optional(),
});
export type WorkerInfo = z.infer<typeof WorkerInfoSchema>;
export type WorkerState = z.infer<typeof WorkerStateSchema>;

export const ScrubCommandSchema = z.enum([
  'start',
  'pause',
  'resume',
  'cancel',
]);
export type ScrubCommand = z.infer<typeof ScrubCommandSchema>;

/**
 * A **request** shape — the only one in this file, which otherwise holds
 * responses. It lives here anyway because it is a Garage wire shape and this is
 * where Garage wire shapes are.
 *
 * Untagged again: eight of the ten variants are bare strings and the ninth is
 * `{scrub: ScrubCommand}`. Getting this wrong sends Garage a body it rejects at
 * best, and asks for the wrong repair at worst, so repair.test.ts pins both arms.
 */
export const RepairTypeSchema = z.union([
  z.enum([
    'tables',
    'blocks',
    'versions',
    'multipartUploads',
    'blockRefs',
    'blockRc',
    'rebalance',
    'aliases',
    'clearResyncQueue',
  ]),
  z.object({ scrub: ScrubCommandSchema }),
]);
export type RepairType = z.infer<typeof RepairTypeSchema>;

export const ListWorkersMultiSchema = multiResponseSchema(
  z.array(WorkerInfoSchema)
);

/**
 * The spec's per-node success value for a launched repair is literally `null` —
 * it carries no information. Parse it as `unknown` and never read it: *which
 * map the node id landed in* is the entire result, and validating a value we
 * will never look at is only a way to fail a call that actually succeeded.
 */
export const LaunchRepairMultiSchema = multiResponseSchema(z.unknown());
