import { RecordService } from 'pocketbase';
import type { ListResult } from 'pocketbase';
import {
  type StorageClaim,
  type StorageClaimInput,
  StorageClaimInputSchema,
} from '../schema/storage-claim';
import type { TypedPocketBase } from '../types';
import { BaseMutator, type MutatorOptions } from './base';

export class StorageClaimMutator extends BaseMutator<
  StorageClaim,
  StorageClaimInput
> {
  constructor(pb: TypedPocketBase, options?: Partial<MutatorOptions>) {
    super(pb, options);
  }

  protected getCollection(): RecordService<StorageClaim> {
    return this.pb.collection('StorageClaims');
  }

  protected setDefaults(): MutatorOptions {
    return {
      expand: [],
      filter: [],
      sort: ['-created'],
    };
  }

  protected async validateInput(
    input: StorageClaimInput
  ): Promise<StorageClaimInput> {
    return StorageClaimInputSchema.parse(input);
  }

  async listByUser(userId: string): Promise<ListResult<StorageClaim>> {
    return this.getList(1, 200, `user = "${userId}"`);
  }

  async listByNode(nodeId: string): Promise<ListResult<StorageClaim>> {
    return this.getList(1, 200, `node_id = "${nodeId}"`);
  }

  /** Every ledger entry for one user on one node, newest first. */
  async listByUserAndNode(
    userId: string,
    nodeId: string
  ): Promise<ListResult<StorageClaim>> {
    return this.getList(1, 1000, `user = "${userId}" && node_id = "${nodeId}"`);
  }

  /**
   * Sum of ledger entries for a user across all nodes (in GB).
   * This is the user's effective total claim — used to validate that their
   * total bucket allocation does not exceed what they have been granted.
   */
  async sumByUser(userId: string): Promise<number> {
    const result = await this.getList(1, 1000, `user = "${userId}"`);
    return sumEntries(result.items);
  }

  /**
   * Sum of ledger entries on a node across all users (in GB, logical/post-replication).
   * Used to validate the per-node usable capacity is not over-claimed.
   */
  async sumByNode(nodeId: string): Promise<number> {
    const result = await this.getList(1, 1000, `node_id = "${nodeId}"`);
    return sumEntries(result.items);
  }

  /**
   * A user's effective claim on a single node (in GB) — the sum of their
   * ledger entries there. Must never be driven negative, or the node's
   * total allocation would understate what other users may still claim.
   */
  async sumByUserAndNode(userId: string, nodeId: string): Promise<number> {
    const result = await this.listByUserAndNode(userId, nodeId);
    return sumEntries(result.items);
  }
}

/** Sum a set of ledger entries, tolerating null/undefined amounts. */
export function sumEntries(entries: readonly StorageClaim[]): number {
  return entries.reduce((sum, c) => sum + (Number(c.quota_gb) || 0), 0);
}
