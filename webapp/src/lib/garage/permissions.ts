import 'server-only';
import { z } from 'zod';
import { GarageClient } from './client';

export interface BucketKeyPermissions {
  read?: boolean;
  write?: boolean;
  owner?: boolean;
}

export async function allowBucketKey(
  client: GarageClient,
  input: {
    bucketId: string;
    accessKeyId: string;
    permissions: BucketKeyPermissions;
  }
): Promise<void> {
  await client.request('/v2/AllowBucketKey', z.unknown(), {
    method: 'POST',
    body: {
      bucketId: input.bucketId,
      accessKeyId: input.accessKeyId,
      permissions: input.permissions,
    },
  });
}

export async function denyBucketKey(
  client: GarageClient,
  input: {
    bucketId: string;
    accessKeyId: string;
    permissions: BucketKeyPermissions;
  }
): Promise<void> {
  await client.request('/v2/DenyBucketKey', z.unknown(), {
    method: 'POST',
    body: {
      bucketId: input.bucketId,
      accessKeyId: input.accessKeyId,
      permissions: input.permissions,
    },
  });
}
