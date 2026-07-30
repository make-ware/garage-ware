import { RecordService } from 'pocketbase';
import { type Admin, type AdminInput, AdminInputSchema } from '../schema/admin';
import type { TypedPocketBase } from '../types';
import { BaseMutator, type MutatorOptions } from './base';

export class AdminMutator extends BaseMutator<Admin, AdminInput> {
  constructor(pb: TypedPocketBase, options?: Partial<MutatorOptions>) {
    super(pb, options);
  }

  protected getCollection(): RecordService<Admin> {
    return this.pb.collection('Admins');
  }

  protected setDefaults(): MutatorOptions {
    return {
      expand: ['user'],
      filter: [],
      sort: ['created'],
    };
  }

  protected async validateInput(input: AdminInput): Promise<AdminInput> {
    return AdminInputSchema.parse(input);
  }

  /** Returns true if the given user id is currently an admin. */
  async isAdmin(userId: string): Promise<boolean> {
    const record = await this.getFirstByFilter(`user = "${userId}"`);
    return record !== null;
  }

  async findByUser(userId: string): Promise<Admin | null> {
    return this.getFirstByFilter(`user = "${userId}"`);
  }
}
