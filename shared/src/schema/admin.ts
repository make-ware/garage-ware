import {
  baseSchema,
  defineCollection,
  RelationField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

export const AdminSchema = z
  .object({
    user: RelationField({ collection: 'Users', cascadeDelete: true }),
  })
  .extend(baseSchema);

export const AdminInputSchema = z.object({
  user: z.string().min(1, 'User is required'),
});

export const AdminCollection = defineCollection({
  collectionName: 'Admins',
  schema: AdminSchema,
  permissions: {
    listRule: '@collection.Admins.user ?= @request.auth.id',
    viewRule: '@collection.Admins.user ?= @request.auth.id',
    createRule: '@collection.Admins.user ?= @request.auth.id',
    updateRule: '@collection.Admins.user ?= @request.auth.id',
    deleteRule: '@collection.Admins.user ?= @request.auth.id',
  },
  indexes: ['CREATE UNIQUE INDEX `idx_admins_user` ON `Admins` (`user`)'],
});

export default AdminCollection;

export type Admin = z.infer<typeof AdminSchema>;
export type AdminInput = z.infer<typeof AdminInputSchema>;
