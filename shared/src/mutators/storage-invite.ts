import { RecordService } from 'pocketbase';
import type { ListResult } from 'pocketbase';
import {
  type StorageInvite,
  type StorageInviteInput,
  StorageInviteInputSchema,
} from '../schema/storage-invite';
import type { TypedPocketBase } from '../types';
import { BaseMutator, type MutatorOptions } from './base';

/** Escape a value for interpolation into a PocketBase filter string. */
function quote(value: string): string {
  return value.replace(/"/g, '');
}

export class StorageInviteMutator extends BaseMutator<
  StorageInvite,
  StorageInviteInput
> {
  constructor(pb: TypedPocketBase, options?: Partial<MutatorOptions>) {
    super(pb, options);
  }

  protected getCollection(): RecordService<StorageInvite> {
    return this.pb.collection('StorageInvites');
  }

  protected setDefaults(): MutatorOptions {
    return {
      expand: [],
      filter: [],
      sort: ['-created'],
    };
  }

  protected async validateInput(
    input: StorageInviteInput
  ): Promise<StorageInviteInput> {
    return StorageInviteInputSchema.parse(input);
  }

  /** Every invite a user has sent, whatever became of it. */
  async listByFromUser(userId: string): Promise<ListResult<StorageInvite>> {
    return this.getList(1, 500, `from_user = "${quote(userId)}"`);
  }

  /** Only the ones still promising something. */
  async listPendingByFromUser(
    userId: string
  ): Promise<ListResult<StorageInvite>> {
    return this.getList(
      1,
      500,
      `from_user = "${quote(userId)}" && status = "pending"`
    );
  }

  /**
   * Pending invites addressed to a mailbox.
   *
   * `to_email` is stored lowercased so this stays a plain equality match —
   * PocketBase filters have no case-insensitive comparison, and normalising on
   * write beats hoping every caller lowercases on read.
   */
  async listPendingByEmail(email: string): Promise<ListResult<StorageInvite>> {
    return this.getList(
      1,
      500,
      `to_email = "${quote(email.trim().toLowerCase())}" && status = "pending"`
    );
  }

  /**
   * What a user has already promised away but not yet paid.
   *
   * The transfer guard subtracts this from available capacity, so a user
   * cannot promise the same gigabyte to five people at once.
   */
  async sumPendingByFromUser(userId: string): Promise<number> {
    const result = await this.listPendingByFromUser(userId);
    return result.items.reduce((sum, i) => sum + (Number(i.quota_gb) || 0), 0);
  }
}
