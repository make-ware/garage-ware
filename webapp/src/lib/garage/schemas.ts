import 'server-only';
import { z } from 'zod';

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

export const GarageKeySchema = z.object({
  accessKeyId: z.string(),
  secretAccessKey: z.string().optional(),
  name: z.string().optional(),
  permissions: KeyPermissionsSchema.optional(),
  buckets: z.array(KeyBucketAccessSchema).optional(),
  expired: z.boolean().optional(),
});
export type GarageKey = z.infer<typeof GarageKeySchema>;

export const GarageKeyListItemSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
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
  objects: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
  unfinishedUploads: z.number().int().nonnegative().optional(),
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
