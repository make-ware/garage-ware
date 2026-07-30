import { RecordService } from 'pocketbase';
import type { ListResult } from 'pocketbase';
import {
  type Bucket,
  type BucketInput,
  BucketInputSchema,
} from '../schema/bucket';
import type { TypedPocketBase } from '../types';
import { BaseMutator, type MutatorOptions } from './base';

export class BucketMutator extends BaseMutator<Bucket, BucketInput> {
  constructor(pb: TypedPocketBase, options?: Partial<MutatorOptions>) {
    super(pb, options);
  }

  protected getCollection(): RecordService<Bucket> {
    return this.pb.collection('Buckets');
  }

  protected setDefaults(): MutatorOptions {
    return {
      expand: [],
      filter: [],
      sort: ['-created'],
    };
  }

  protected async validateInput(input: BucketInput): Promise<BucketInput> {
    return BucketInputSchema.parse(input);
  }

  async listByUser(userId: string): Promise<ListResult<Bucket>> {
    return this.getList(1, 200, `user = "${userId}"`);
  }

  async findByGarageId(garageBucketId: string): Promise<Bucket | null> {
    return this.getFirstByFilter(`garage_bucket_id = "${garageBucketId}"`);
  }

  /**
   * Sum of allocated bucket quotas for a user (in GB).
   * Used to validate the user's total claim is not exceeded.
   */
  async sumAllocatedGb(
    userId: string,
    excludeBucketId?: string
  ): Promise<number> {
    const filterParts = [`user = "${userId}"`];
    if (excludeBucketId) {
      filterParts.push(`id != "${excludeBucketId}"`);
    }
    const result = await this.getList(1, 1000, filterParts.join('&&'));
    return result.items.reduce((sum, b) => sum + (Number(b.quota_gb) || 0), 0);
  }
}
