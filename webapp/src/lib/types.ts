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
  StorageClaimAudit,
  StorageNodeBalance,
  StorageUserBalance,
  StorageTransfer,
  StorageInvite,
} from '@garage-ware/shared';
import type { NodeClaimPosition } from '@/lib/storage/ledger-math';

export interface TypedPocketBase extends PocketBase {
  collection(idOrName: 'Users' | 'users'): RecordService<User>;
  collection(idOrName: 'Admins'): RecordService<Admin>;
  collection(idOrName: 'AccessKeys'): RecordService<AccessKey>;
  collection(idOrName: 'Buckets'): RecordService<Bucket>;
  collection(idOrName: 'StorageClaims'): RecordService<StorageClaim>;
  collection(idOrName: 'StorageClaimAudit'): RecordService<StorageClaimAudit>;
  collection(
    idOrName: 'StorageNodeBalances'
  ): RecordService<StorageNodeBalance>;
  collection(
    idOrName: 'StorageUserBalances'
  ): RecordService<StorageUserBalance>;
  collection(idOrName: 'StorageTransfers'): RecordService<StorageTransfer>;
  collection(idOrName: 'StorageInvites'): RecordService<StorageInvite>;
}

/**
 * A transfer row carrying the counterparty's email rather than only their id.
 *
 * `StorageTransfers` stores relations, and a user cannot resolve another
 * user's record (the Users listRule is self-or-admin) — so the address is
 * attached server-side by `GET /next-api/garage/transfers`. It stays optional:
 * a counterparty whose account has since been deleted has no address to show.
 */
export type LabelledTransfer = StorageTransfer & {
  from_email?: string;
  to_email?: string;
};

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
 *
 * `nodeClaims` is the per-node breakdown rather than the raw ledger entries:
 * the position is read from the materialized balances now, which store the
 * roll-up, and every consumer only ever wanted the roll-up anyway.
 */
export interface StorageSummary {
  nodeClaims: NodeClaimPosition[];
  sentTransfers: StorageTransfer[];
  receivedTransfers: StorageTransfer[];
  claimsGb: number;
  sentGb: number;
  receivedGb: number;
  netGrantedGb: number;
  allocatedGb: number;
  availableGb: number;
}
