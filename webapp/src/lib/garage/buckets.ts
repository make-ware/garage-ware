import 'server-only';
import { z } from 'zod';
import { GarageClient } from './client';
import { GarageNotFoundError } from './errors';
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

/**
 * Delete a bucket, and with it every alias pointing at it.
 *
 * **Garage refuses a non-empty bucket** — `400 "Bucket is not empty"`, which
 * `client.ts` maps to `code: 'not_empty'`. That rule is Garage's, not ours, and
 * it is the reason bucket deletion is safe to expose at all: the only bucket a
 * user can destroy through this app is one holding nothing. The route checks
 * emptiness first so it can say *how* full the bucket is, but this 400 is the
 * authority — the two reads are not atomic and an upload can land between them.
 *
 * **A 404 is success**, not failure: the caller asked for the bucket to be
 * gone and it is. Without that, a PocketBase row whose Garage bucket had
 * already been removed could never be cleaned up through the UI — every retry
 * would 404 before reaching the PocketBase delete, stranding the row and the
 * `allocated_gb` it reserves.
 *
 * `id` goes in the **query string**. The spec declares it a required query
 * parameter and documents no request body at all; the version of this function
 * that sat here commented out put it in the body, where `buildUrl` would never
 * have seen it — it would have posted `/v2/DeleteBucket` with no id.
 */
export async function deleteBucket(
  client: GarageClient,
  bucketId: string
): Promise<void> {
  try {
    await client.request('/v2/DeleteBucket', z.unknown(), {
      method: 'POST',
      query: { id: bucketId },
    });
  } catch (err) {
    if (err instanceof GarageNotFoundError) return;
    throw err;
  }
}
