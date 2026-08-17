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
    // All three write rules are null, as on NodeOwners, StorageClaims and
    // ClusterEvents. They used to be `user = @request.auth.id || <admin>`,
    // which meant the Route-Handler funnel was convention rather than
    // enforcement — and once `garage_key_id` became something a user can
    // *claim* by proving they hold a credential, convention was not enough: a
    // browser SDK call could insert a row naming any Garage access key and
    // itself as the owner, or repoint an existing row it already owned, and
    // skip the proof entirely. Reads stay self-or-admin, so `loadOwned*` still
    // resolves ownership through the caller's own client.
    createRule: null,
    updateRule: null,
    deleteRule: null,
  },
  indexes: [
    // UNIQUE, and it is the concurrency control for claiming rather than a mere
    // constraint — the same role it plays on NodeOwners.node_id. Two
    // simultaneous claims mean one insert and one uniqueness violation, which
    // the route maps to 409; there is no pre-flight existence check to race.
    'CREATE UNIQUE INDEX `idx_accesskeys_garage_key_id` ON `AccessKeys` (`garage_key_id`)',
    'CREATE INDEX `idx_accesskeys_user` ON `AccessKeys` (`user`)',
  ],
});

export default AccessKeyCollection;

export type AccessKey = z.infer<typeof AccessKeySchema>;
export type AccessKeyInput = z.infer<typeof AccessKeyInputSchema>;
