import { RecordService } from 'pocketbase';
import { type User, type UserInput, UserInputSchema } from '../schema/user';
import type { TypedPocketBase } from '../types';
import { BaseMutator } from './base';

export class UserMutator extends BaseMutator<User, UserInput> {
  constructor(pb: TypedPocketBase) {
    super(pb);
  }

  protected getCollection(): RecordService<User> {
    return this.pb.collection('Users');
  }

  protected async validateInput(input: UserInput): Promise<UserInput> {
    return UserInputSchema.parse(input);
  }
}
