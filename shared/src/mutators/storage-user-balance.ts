import { RecordService } from 'pocketbase';
import {
  type StorageUserBalance,
  type StorageUserBalanceInput,
  StorageUserBalanceInputSchema,
} from '../schema/storage-user-balance';
import type { TypedPocketBase } from '../types';
import { BaseMutator, type MutatorOptions } from './base';

/**
 * Read access to the per-user transfer/allocation roll-ups.
 *
 * Read-only in practice — see StorageNodeBalanceMutator for why.
 */
export class StorageUserBalanceMutator extends BaseMutator<
  StorageUserBalance,
  StorageUserBalanceInput
> {
  constructor(pb: TypedPocketBase, options?: Partial<MutatorOptions>) {
    super(pb, options);
  }

  protected getCollection(): RecordService<StorageUserBalance> {
    return this.pb.collection('StorageUserBalances');
  }

  protected setDefaults(): MutatorOptions {
    return { expand: [], filter: [], sort: ['-created'] };
  }

  protected async validateInput(
    input: StorageUserBalanceInput
  ): Promise<StorageUserBalanceInput> {
    return StorageUserBalanceInputSchema.parse(input);
  }

  /**
   * Returns null when the user has no balance row yet — a user who has never
   * been party to a transfer or owned a bucket simply has nothing to store.
   * Callers should treat that as a zeroed position, not an error.
   */
  async findByUser(userId: string): Promise<StorageUserBalance | null> {
    return this.getFirstByFilter(`user = "${userId}"`);
  }
}
