import { RecordService } from 'pocketbase';
import type { ListResult } from 'pocketbase';
import {
  type StorageTransfer,
  type StorageTransferInput,
  StorageTransferInputSchema,
} from '../schema/storage-transfer';
import type { TypedPocketBase } from '../types';
import { BaseMutator, type MutatorOptions } from './base';

export class StorageTransferMutator extends BaseMutator<
  StorageTransfer,
  StorageTransferInput
> {
  constructor(pb: TypedPocketBase, options?: Partial<MutatorOptions>) {
    super(pb, options);
  }

  protected getCollection(): RecordService<StorageTransfer> {
    return this.pb.collection('StorageTransfers');
  }

  protected setDefaults(): MutatorOptions {
    return {
      expand: [],
      filter: [],
      sort: ['-created'],
    };
  }

  protected async validateInput(
    input: StorageTransferInput
  ): Promise<StorageTransferInput> {
    return StorageTransferInputSchema.parse(input);
  }

  async listSentByUser(userId: string): Promise<ListResult<StorageTransfer>> {
    return this.getList(1, 500, `from_user = "${userId}"`);
  }

  async listReceivedByUser(
    userId: string
  ): Promise<ListResult<StorageTransfer>> {
    return this.getList(1, 500, `to_user = "${userId}"`);
  }

  async sumSentByUser(userId: string): Promise<number> {
    const result = await this.listSentByUser(userId);
    return result.items.reduce((sum, t) => sum + (Number(t.quota_gb) || 0), 0);
  }

  async sumReceivedByUser(userId: string): Promise<number> {
    const result = await this.listReceivedByUser(userId);
    return result.items.reduce((sum, t) => sum + (Number(t.quota_gb) || 0), 0);
  }
}
