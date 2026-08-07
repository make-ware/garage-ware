import { RecordService } from 'pocketbase';
import type { ListResult } from 'pocketbase';
import {
  type StorageNodeBalance,
  type StorageNodeBalanceInput,
  StorageNodeBalanceInputSchema,
} from '../schema/storage-node-balance';
import type { TypedPocketBase } from '../types';
import { BaseMutator, type MutatorOptions } from './base';

/**
 * Read access to the per-(user, node) claim roll-ups.
 *
 * Read-only in practice: the rows are written by the PocketBase hooks and the
 * collection's write rules are null, so the inherited create/update/delete
 * would be rejected. Nothing in the app should call them.
 *
 * Page sizes here are generous on purpose — these are roll-ups, so the row
 * count is bounded by (users x nodes), not by ledger length. That is the whole
 * point of the collection.
 */
export class StorageNodeBalanceMutator extends BaseMutator<
  StorageNodeBalance,
  StorageNodeBalanceInput
> {
  constructor(pb: TypedPocketBase, options?: Partial<MutatorOptions>) {
    super(pb, options);
  }

  protected getCollection(): RecordService<StorageNodeBalance> {
    return this.pb.collection('StorageNodeBalances');
  }

  protected setDefaults(): MutatorOptions {
    return { expand: [], filter: [], sort: ['node_id'] };
  }

  protected async validateInput(
    input: StorageNodeBalanceInput
  ): Promise<StorageNodeBalanceInput> {
    return StorageNodeBalanceInputSchema.parse(input);
  }

  /** Every node this user holds a claim on. */
  async listByUser(userId: string): Promise<ListResult<StorageNodeBalance>> {
    return this.getList(1, 500, `user = "${userId}"`);
  }

  /** Every user holding a claim on this node — the per-node capacity check. */
  async listByNode(nodeId: string): Promise<ListResult<StorageNodeBalance>> {
    return this.getList(1, 500, `node_id = "${nodeId}"`);
  }

  async findByUserAndNode(
    userId: string,
    nodeId: string
  ): Promise<StorageNodeBalance | null> {
    return this.getFirstByFilter([
      `user = "${userId}"`,
      `node_id = "${nodeId}"`,
    ]);
  }
}
