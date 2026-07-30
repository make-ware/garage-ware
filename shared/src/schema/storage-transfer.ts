import {
  baseSchema,
  defineCollection,
  NumberField,
  RelationField,
  TextField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

export const StorageTransferSchema = z
  .object({
    from_user: RelationField({ collection: 'Users', cascadeDelete: true }),
    to_user: RelationField({ collection: 'Users', cascadeDelete: true }),
    quota_gb: NumberField({ min: 0.001 }),
    note: TextField({ max: 500 }).optional(),
  })
  .extend(baseSchema);

export const StorageTransferInputSchema = z.object({
  from_user: z.string().min(1),
  to_user: z.string().min(1),
  quota_gb: z.number().min(0.001),
  note: z.string().max(500).optional(),
});

export const StorageTransferCollection = defineCollection({
  collectionName: 'StorageTransfers',
  schema: StorageTransferSchema,
  permissions: {
    listRule:
      'from_user = @request.auth.id || to_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    viewRule:
      'from_user = @request.auth.id || to_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    createRule:
      'from_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    updateRule: null,
    deleteRule:
      'to_user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
  },
  indexes: [
    'CREATE INDEX `idx_storagetransfers_from_user` ON `StorageTransfers` (`from_user`)',
    'CREATE INDEX `idx_storagetransfers_to_user` ON `StorageTransfers` (`to_user`)',
  ],
});

export default StorageTransferCollection;

export type StorageTransfer = z.infer<typeof StorageTransferSchema>;
export type StorageTransferInput = z.infer<typeof StorageTransferInputSchema>;
