import {
  baseSchema,
  defineCollection,
  RelationField,
  TextField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

export const AccessKeySchema = z
  .object({
    user: RelationField({ collection: 'Users', cascadeDelete: true }),
    garage_key_id: TextField().min(1).max(128),
    name: TextField({ max: 100 }).optional(),
  })
  .extend(baseSchema);

export const AccessKeyInputSchema = z.object({
  user: z.string().min(1),
  garage_key_id: z.string().min(1).max(128),
  name: z.string().max(100).optional(),
});

export const AccessKeyCollection = defineCollection({
  collectionName: 'AccessKeys',
  schema: AccessKeySchema,
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
    'CREATE UNIQUE INDEX `idx_accesskeys_garage_key_id` ON `AccessKeys` (`garage_key_id`)',
    'CREATE INDEX `idx_accesskeys_user` ON `AccessKeys` (`user`)',
  ],
});

export default AccessKeyCollection;

export type AccessKey = z.infer<typeof AccessKeySchema>;
export type AccessKeyInput = z.infer<typeof AccessKeyInputSchema>;
