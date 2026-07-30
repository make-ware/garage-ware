import {
  baseSchema,
  DateField,
  defineCollection,
  NumberField,
  RelationField,
  TextField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

export const BucketSchema = z
  .object({
    user: RelationField({ collection: 'Users', cascadeDelete: false }),
    garage_bucket_id: TextField().min(1).max(128),
    name: TextField().min(1).max(63),
    quota_gb: NumberField({ min: 0 }).default(0),
    // Last-known usage + quota snapshot from Garage, in raw Garage units. Cache
    // only — not authoritative. Refreshed by webapp route handlers on dashboard
    // reads; consumed by the daily bucket-usage-alerts cron in
    // pb_hooks/main.pb.js. Paired usage/cap: `bytes`/`max_size` (bytes) and
    // `objects`/`max_objects` (count); a `max_*` of 0 / unset means no cap.
    // `max_size` mirrors `quota_gb` in bytes — `quota_gb` (binary GiB) stays the
    // authoritative size quota; `max_size` is the convenience byte snapshot.
    bytes: NumberField({ min: 0 }).int().optional(),
    objects: NumberField({ min: 0 }).int().optional(),
    max_size: NumberField({ min: 0 }).int().optional(),
    max_objects: NumberField({ min: 0 }).int().optional(),
    usage_updated_at: DateField().optional(),
  })
  .extend(baseSchema);

export const BucketInputSchema = z.object({
  user: z.string().min(1),
  garage_bucket_id: z.string().min(1).max(128),
  name: z
    .string()
    .min(3)
    .max(63)
    .regex(
      /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/,
      'Bucket name must be S3-compatible: lowercase, digits, dot/hyphen, no leading/trailing special chars'
    ),
  quota_gb: z.number().min(0).default(0),
});

export const BucketCollection = defineCollection({
  collectionName: 'Buckets',
  schema: BucketSchema,
  permissions: {
    listRule:
      'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    viewRule:
      'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    createRule:
      'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    updateRule:
      'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    deleteRule:
      'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
  },
  indexes: [
    'CREATE UNIQUE INDEX `idx_buckets_garage_bucket_id` ON `Buckets` (`garage_bucket_id`)',
    'CREATE UNIQUE INDEX `idx_buckets_name` ON `Buckets` (`name`)',
    'CREATE INDEX `idx_buckets_user` ON `Buckets` (`user`)',
  ],
});

export default BucketCollection;

export type Bucket = z.infer<typeof BucketSchema>;
export type BucketInput = z.infer<typeof BucketInputSchema>;
