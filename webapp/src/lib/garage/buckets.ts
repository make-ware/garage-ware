import 'server-only';
import { GarageClient } from './client';
import {
  GarageBucketListSchema,
  GarageBucketSchema,
  type GarageBucket,
  type GarageBucketListItem,
} from './schemas';

export async function listBuckets(
  client: GarageClient
): Promise<GarageBucketListItem[]> {
  return client.request('/v2/ListBuckets', GarageBucketListSchema);
}

export async function getBucketInfo(
  client: GarageClient,
  query: { id?: string; globalAlias?: string }
): Promise<GarageBucket> {
  return client.request('/v2/GetBucketInfo', GarageBucketSchema, {
    query: { id: query.id, globalAlias: query.globalAlias },
  });
}

export async function createBucket(
  client: GarageClient,
  input: { globalAlias: string }
): Promise<GarageBucket> {
  return client.request('/v2/CreateBucket', GarageBucketSchema, {
    method: 'POST',
    body: { globalAlias: input.globalAlias },
  });
}

export async function updateBucket(
  client: GarageClient,
  input: {
    id: string;
    quotas?: { maxSize?: number | null; maxObjects?: number | null };
    websiteAccess?: {
      enabled: boolean;
      indexDocument?: string;
      errorDocument?: string;
    };
  }
): Promise<GarageBucket> {
  const { id, ...body } = input;
  return client.request('/v2/UpdateBucket', GarageBucketSchema, {
    method: 'POST',
    query: { id },
    body,
  });
}

export async function deleteBucket(
  _client: GarageClient,
  _bucketId: string
): Promise<void> {
  // TODO: re-enable Garage bucket deletion once we're done testing.
  // await _client.request('/v2/DeleteBucket', z.unknown(), {
  //   method: 'POST',
  //   body: { id: _bucketId },
  // });
  throw new Error('deleteBucket is temporarily disabled while testing');
}
