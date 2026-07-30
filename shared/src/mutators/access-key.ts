import { RecordService } from 'pocketbase';
import type { ListResult } from 'pocketbase';
import {
  type AccessKey,
  type AccessKeyInput,
  AccessKeyInputSchema,
} from '../schema/access-key';
import type { TypedPocketBase } from '../types';
import { BaseMutator, type MutatorOptions } from './base';

export class AccessKeyMutator extends BaseMutator<AccessKey, AccessKeyInput> {
  constructor(pb: TypedPocketBase, options?: Partial<MutatorOptions>) {
    super(pb, options);
  }

  protected getCollection(): RecordService<AccessKey> {
    return this.pb.collection('AccessKeys');
  }

  protected setDefaults(): MutatorOptions {
    return {
      expand: [],
      filter: [],
      sort: ['-created'],
    };
  }

  protected async validateInput(
    input: AccessKeyInput
  ): Promise<AccessKeyInput> {
    return AccessKeyInputSchema.parse(input);
  }

  async listByUser(userId: string): Promise<ListResult<AccessKey>> {
    return this.getList(1, 200, `user = "${userId}"`);
  }

  async findByGarageId(garageKeyId: string): Promise<AccessKey | null> {
    return this.getFirstByFilter(`garage_key_id = "${garageKeyId}"`);
  }
}
