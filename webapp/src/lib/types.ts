// Local TypeScript types for webapp
// These types use the webapp's PocketBase version to avoid type mismatches

import PocketBase from 'pocketbase';
import type { RecordService } from 'pocketbase';
import type {
  User,
  Admin,
  AccessKey,
  Bucket,
  StorageClaim,
  StorageTransfer,
} from '@garage-ware/shared';

export interface TypedPocketBase extends PocketBase {
  collection(idOrName: 'Users' | 'users'): RecordService<User>;
  collection(idOrName: 'Admins'): RecordService<Admin>;
  collection(idOrName: 'AccessKeys'): RecordService<AccessKey>;
  collection(idOrName: 'Buckets'): RecordService<Bucket>;
  collection(idOrName: 'StorageClaims'): RecordService<StorageClaim>;
  collection(idOrName: 'StorageTransfers'): RecordService<StorageTransfer>;
}

export type BucketWithUsage = Bucket & {
  bytes?: number;
  objects?: number;
  maxObjects?: number | null;
};

/**
 * A user's complete storage position, computed in one place by the
 * `getUserStorageSummary` service and served from `/next-api/garage/storage-summary`.
 * This is the single shared shape both the dashboard and bucket-detail pages
 * consume so the claims − transfers − allocated math never diverges.
 */
export interface StorageSummary {
  claims: StorageClaim[];
  sentTransfers: StorageTransfer[];
  receivedTransfers: StorageTransfer[];
  claimsGb: number;
  sentGb: number;
  receivedGb: number;
  netGrantedGb: number;
  allocatedGb: number;
  availableGb: number;
}
