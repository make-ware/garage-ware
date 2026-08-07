// Shared TypeScript types

import PocketBase from 'pocketbase';
import type { RecordService } from 'pocketbase';
import type { User } from '../schema/user';
import type { Admin } from '../schema/admin';
import type { AccessKey } from '../schema/access-key';
import type { Bucket } from '../schema/bucket';
import type { StorageClaim } from '../schema/storage-claim';
import type { StorageClaimAudit } from '../schema/storage-claim-audit';
import type { StorageTransfer } from '../schema/storage-transfer';

// Typed PocketBase interface
export interface TypedPocketBase extends PocketBase {
  collection(idOrName: 'Users'): RecordService<User>;
  collection(idOrName: 'Admins'): RecordService<Admin>;
  collection(idOrName: 'AccessKeys'): RecordService<AccessKey>;
  collection(idOrName: 'Buckets'): RecordService<Bucket>;
  collection(idOrName: 'StorageClaims'): RecordService<StorageClaim>;
  collection(idOrName: 'StorageClaimAudit'): RecordService<StorageClaimAudit>;
  collection(idOrName: 'StorageTransfers'): RecordService<StorageTransfer>;
}

// PocketBase response types
export interface PocketBaseResponse<T = Record<string, unknown>> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
}

// API response types
export interface ApiResponse<T = Record<string, unknown>> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Common utility types
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;
