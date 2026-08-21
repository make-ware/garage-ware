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
/**
 * `zoneRedundancy` in the two shapes the admin API documents: the literal
 * `"maximum"`, or `{ atLeast: n }`.
 *
 * Narrowed from `z.unknown()` because the layout planner needs to *reason* with
 * it — the effective redundancy `k` is `min(zones, rf)` under `maximum` and the
 * given number otherwise, and that choice decides how many replicas of a
 * partition one zone may hold. It stays **optional**, and a value matching
 * neither shape still parses as `undefined` rather than failing the whole
 * layout read: older Garage releases have carried other shapes, and nothing
 * else in the app looks at this field. A cluster read must not start failing
 * over a parameter only one page consumes.
 */
const ZoneRedundancySchema = z.union([
  z.literal('maximum'),
  z.object({ atLeast: z.number().int() }),
]);

/**
 * One entry of `stagedRoleChanges` — a change waiting for `garage layout apply`.
 *
 * An untagged union in the spec: `{id, remove: true}`, or `{id, zone, capacity,
 * tags}`. The third member is the load-bearing one. A staged change this app
 * cannot parse is *exactly* the thing an operator has to be told about, because
 * `garage layout apply` will commit it along with theirs — so an unfamiliar
 * shape degrades to "something is staged on this node, go read `garage layout
 * show`" rather than failing the layout read (which would take the whole admin
 * console down over a field nothing consumes) and rather than
 * `.catch(undefined)`-ing the array (which would report "nothing staged" while
 * something *is* staged — the silent all-clear that `role_ok` and
 * `data-coverage.ts` both exist to prevent). Same `recognised: false` shape as
 * `lib/repair/scrub-status.ts`.
 *
 * The fallback member is a plain `z.object`, so unknown keys are **stripped**:
 * whatever else a future Garage puts on a staged change cannot reach a payload,
 * and in particular cannot smuggle a second full node id past the projection in
 * `/next-api/garage/cluster/staging`.
 */
export const StagedRoleChangeSchema = z.union([
  z.object({ id: z.string(), remove: z.literal(true) }),
  z.object({
    id: z.string(),
    zone: z.string(),
    capacity: z.number().nullable().optional(),
    tags: z.array(z.string()).default([]),
  }),
  z.object({ id: z.string() }),
]);
export type StagedRoleChange = z.infer<typeof StagedRoleChangeSchema>;

export const ClusterLayoutSchema = z.object({
  version: z.number().int(),
  roles: z.array(LayoutNodeSchema),
  parameters: z
    .object({
      zoneRedundancy: ZoneRedundancySchema.optional().catch(undefined),
    })
    .partial()
    .optional(),
  partitionSize: z.number().optional(),
  /**
   * Narrowed from `z.array(z.unknown())`. It was unknown while the only reader
   * was `stagedRoleChanges.length > 0`; the staging page reads the entries
   * themselves, and — more to the point — the admin layout route used to spread
   * this array through untouched, emitting full 64-character node ids the
   * moment anything was staged.
   */
  stagedRoleChanges: z.array(StagedRoleChangeSchema).optional(),
  stagedParameters: z.unknown().nullable().optional(),
});
export type ClusterLayout = z.infer<typeof ClusterLayoutSchema>;

/**
 * `GetClusterLayoutHistory` — per-version node counts, read-only.
 *
 * **`updateTrackers` is deliberately absent.** It is a map *keyed by full node
 * id*, so parsing it would put 64-character ids one spread away from a
 * response body. Nothing in this app needs per-node ack detail; `minAck`
 * answers the only question the page asks.
 *
 * Note also what Garage does not return here: any timestamp at all. A version
 * row says how many storage and gateway nodes it had and nothing about when it
 * happened — which is the whole reason `ClusterEvents` exists.
 */
export const ClusterLayoutHistorySchema = z.object({
  currentVersion: z.number().int().nonnegative(),
  minAck: z.number().int().nonnegative(),
  versions: z.array(
    z.object({
      version: z.number().int().nonnegative(),
      status: z.enum(['Current', 'Draining', 'Historical']),
      storageNodes: z.number().int().nonnegative(),
      gatewayNodes: z.number().int().nonnegative(),
    })
  ),
});
export type ClusterLayoutHistory = z.infer<typeof ClusterLayoutHistorySchema>;

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
 * A **request** shape — one of the two in this file, which otherwise holds
 * responses (the other is `RetryBlockResyncRequestSchema`, below). It lives
 * here anyway because it is a Garage wire shape and this is where Garage wire
 * shapes are.
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

// ── Blocks & node statistics ───────────────────────────────────────────────
//
// `ListBlockErrors`, `RetryBlockResync` and `GetNodeStatistics` all return the
// `{success, error}` envelope from ./multi-node.ts, like the worker endpoints
// above. The first two are `Block`-tagged in the spec and are wrapped in
// lib/garage/blocks.ts rather than repair.ts — retrying a resync is not a
// repair type and must never become a `RepairAction`.

/**
 * One block a node failed to fetch from its peers.
 *
 * **All five fields required, no `.optional()` anywhere**, for the same reason
 * `multiResponseSchema` insists on both its keys: the spec marks all five
 * required, and a build that stopped sending `errorCount` must surface as a
 * `GarageValidationError` rather than as a table of zeroes. A zero in this
 * column reads "this block is fine", which is the opposite of what a missing
 * field means.
 *
 * `blockHash` is a content hash, **not** a credential — see
 * `app/next-api/garage/repairs/repairs-boundary.test.ts` for why it is allowed
 * to be 64 hex characters where a node id is not.
 */
export const BlockErrorSchema = z.object({
  blockHash: z.string(),
  refcount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  lastTrySecsAgo: z.number().int().nonnegative(),
  nextTryInSecs: z.number().int().nonnegative(),
});
export type BlockError = z.infer<typeof BlockErrorSchema>;

export const ListBlockErrorsMultiSchema = multiResponseSchema(
  z.array(BlockErrorSchema)
);

/**
 * The **second** request shape in this file, and the spec's untagged `oneOf`
 * rendered faithfully: either `{all}` or `{blockHashes}`, never both.
 *
 * `z.union`, not `z.discriminatedUnion` — the discriminant is *which key
 * exists*, the same call `RepairTypeSchema` makes. `strictObject`, because
 * `oneOf` means exactly one and an object carrying both keys must be rejected
 * here rather than silently put on the wire. And `z.boolean()`, not
 * `z.literal(true)`, because this schema describes **Garage's protocol**; this
 * app's own policy — only ever `{all: true}` — lives one level up, in
 * `retryBlockResync`'s parameter type and in the route's `z.literal(true)`.
 * That is the `REPAIR_TYPE_FOR_ACTION` split repeated one layer down.
 */
export const RetryBlockResyncRequestSchema = z.union([
  z.strictObject({ all: z.boolean() }),
  z.strictObject({ blockHashes: z.array(z.string()).min(1) }),
]);
export type RetryBlockResyncRequest = z.infer<
  typeof RetryBlockResyncRequestSchema
>;

export const RetryBlockResyncMultiSchema = multiResponseSchema(
  z.object({ count: z.number().int().nonnegative() })
);

const NodeBlockManagerStatsSchema = z.object({
  rcEntries: z.number().int().nonnegative(),
  /** Blocks queued for resync. Rises before it falls; never a progress bar. */
  resyncQueueLen: z.number().int().nonnegative(),
  resyncErrors: z.number().int().nonnegative(),
});

/**
 * Modelled rather than left as `z.unknown()`: six fields is eight lines, and a
 * shape nothing validates is a shape nothing notices changing.
 */
const NodeTableStatsSchema = z.object({
  tableName: z.string(),
  items: z.number().int().nonnegative(),
  merkleItems: z.number().int().nonnegative(),
  merkleQueueLen: z.number().int().nonnegative(),
  insertQueueLen: z.number().int().nonnegative(),
  gcQueueLen: z.number().int().nonnegative(),
});

/**
 * One node's statistics.
 *
 * **Do not parse `freeform`** — the spec says so in the operation's own
 * description, and says why: it is kept for compatibility with older v2.x
 * nodes and its format is not stable. `/next-api/garage/repairs/node-stats`
 * drops it entirely rather than carrying it to the browser. That is the
 * deliberate opposite of what the scrub page does with `WorkerInfoResp
 * .freeform`, where prose is the *only* channel carrying the fact; here the
 * structured fields exist.
 *
 * `blockManagerStats` is nullable in the spec, and null must stay null all the
 * way to the screen: "not reported" and "the queue is empty" are opposite
 * conclusions.
 */
export const NodeStatisticsSchema = z.object({
  freeform: z.string(),
  blockManagerStats: NodeBlockManagerStatsSchema.nullable().optional(),
  tableStats: z.array(NodeTableStatsSchema).nullable().optional(),
});
export type NodeStatistics = z.infer<typeof NodeStatisticsSchema>;

export const NodeStatisticsMultiSchema =
  multiResponseSchema(NodeStatisticsSchema);
