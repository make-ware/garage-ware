import { RecordService } from 'pocketbase';
import type { ListResult } from 'pocketbase';
import {
  type NodeOwner,
  type NodeOwnerInput,
  NodeOwnerInputSchema,
} from '../schema/node-owner';
import type { TypedPocketBase } from '../types';
import { BaseMutator, type MutatorOptions } from './base';

/**
 * PocketBase filters are string-interpolated throughout this directory, and a
 * node id reaches these lookups straight from a request body — strip the
 * character that would end the literal, as ClusterEventMutator does.
 */
function quote(value: string): string {
  return value.replace(/"/g, '');
}

/**
 * Read access to node ownership.
 *
 * Read-only in practice, like ClusterEventMutator: the collection's write rules
 * are all null, so the inherited create/update/delete would be rejected for any
 * caller but a superuser. Claiming and releasing go through
 * /next-api/garage/nodes/owners, which authenticates as one.
 *
 * Every read here is subject to the self-or-admin listRule, which is the point:
 * `findByNode` returning a row *is* the proof that the caller owns that node.
 */
export class NodeOwnerMutator extends BaseMutator<NodeOwner, NodeOwnerInput> {
  constructor(pb: TypedPocketBase, options?: Partial<MutatorOptions>) {
    super(pb, options);
  }

  protected getCollection(): RecordService<NodeOwner> {
    return this.pb.collection('NodeOwners');
  }

  protected setDefaults(): MutatorOptions {
    return { expand: [], filter: [], sort: ['-created'] };
  }

  protected async validateInput(
    input: NodeOwnerInput
  ): Promise<NodeOwnerInput> {
    return NodeOwnerInputSchema.parse(input);
  }

  /**
   * The owner of one node, or null.
   *
   * Under a non-admin caller the listRule scopes this to their own rows, so a
   * null means "not yours" and not necessarily "unowned" — the claim route
   * relies on the UNIQUE index, not on this, to decide whether a node is free.
   */
  async findByNode(nodeId: string): Promise<NodeOwner | null> {
    return this.getFirstByFilter([`node_id = "${quote(nodeId)}"`]);
  }

  /** Every node this user owns. */
  async listByUser(userId: string): Promise<ListResult<NodeOwner>> {
    return this.getList(1, 500, `user = "${quote(userId)}"`);
  }

  /** Every ownership row. Admin-only in effect, via the listRule. */
  async listAll(): Promise<ListResult<NodeOwner>> {
    return this.getList(1, 500);
  }
}
