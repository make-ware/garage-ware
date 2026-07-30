import 'server-only';
import { z } from 'zod';
import { GarageClient } from './client';
import {
  GarageKeyListSchema,
  GarageKeySchema,
  type GarageKey,
  type GarageKeyListItem,
} from './schemas';

export async function listKeys(
  client: GarageClient
): Promise<GarageKeyListItem[]> {
  return client.request('/v2/ListKeys', GarageKeyListSchema);
}

export async function getKeyInfo(
  client: GarageClient,
  accessKeyId: string
): Promise<GarageKey> {
  return client.request('/v2/GetKeyInfo', GarageKeySchema, {
    query: { id: accessKeyId, showSecretKey: 'true' },
  });
}

const CreateKeyResponseSchema = GarageKeySchema.extend({
  secretAccessKey: z.string(),
});

export async function createKey(
  client: GarageClient,
  input: { name: string; allowCreateBucket?: boolean }
): Promise<z.infer<typeof CreateKeyResponseSchema>> {
  return client.request('/v2/CreateKey', CreateKeyResponseSchema, {
    method: 'POST',
    body: {
      name: input.name,
      allow: input.allowCreateBucket ? { createBucket: true } : undefined,
    },
  });
}

export async function deleteKey(
  _client: GarageClient,
  _accessKeyId: string
): Promise<void> {
  // TODO: re-enable Garage key deletion once we're done testing.
  // await _client.request('/v2/DeleteKey', z.unknown(), {
  //   method: 'POST',
  //   body: { id: _accessKeyId },
  // });
  throw new Error('deleteKey is temporarily disabled while testing');
}

export async function updateKey(
  client: GarageClient,
  input: { id: string; newName?: string }
): Promise<GarageKey> {
  return client.request('/v2/UpdateKey', GarageKeySchema, {
    method: 'POST',
    body: { id: input.id, name: input.newName },
  });
}
