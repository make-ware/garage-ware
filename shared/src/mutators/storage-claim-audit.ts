import { RecordService } from 'pocketbase';
import type { ListResult } from 'pocketbase';
import {
  type ClaimAuditAction,
  type StorageClaimAudit,
  type StorageClaimAuditInput,
  StorageClaimAuditInputSchema,
} from '../schema/storage-claim-audit';
import type { TypedPocketBase } from '../types';
import { BaseMutator, type MutatorOptions } from './base';

/** Filters for the admin audit browser. Every field is optional. */
export interface ClaimAuditQuery {
  userId?: string;
  nodeId?: string;
  claimId?: string;
  action?: ClaimAuditAction;
}

/**
 * Read access to the claim audit trail.
 *
 * Read-only in practice: the rows are written by the PocketBase hooks in
 * pb_hooks/main.pb.js via the Go/JSVM layer, and the collection's write rules
 * are null, so `create`/`update`/`delete` inherited from BaseMutator would be
 * rejected by PocketBase. Nothing in the app should call them.
 */
export class StorageClaimAuditMutator extends BaseMutator<
  StorageClaimAudit,
  StorageClaimAuditInput
> {
  constructor(pb: TypedPocketBase, options?: Partial<MutatorOptions>) {
    super(pb, options);
  }

  protected getCollection(): RecordService<StorageClaimAudit> {
    return this.pb.collection('StorageClaimAudit');
  }

  protected setDefaults(): MutatorOptions {
    return {
      expand: [],
      filter: [],
      sort: ['-created'],
    };
  }

  protected async validateInput(
    input: StorageClaimAuditInput
  ): Promise<StorageClaimAuditInput> {
    return StorageClaimAuditInputSchema.parse(input);
  }

  async listByUser(userId: string): Promise<ListResult<StorageClaimAudit>> {
    return this.getList(1, 200, `user_id = "${userId}"`);
  }

  async listByNode(nodeId: string): Promise<ListResult<StorageClaimAudit>> {
    return this.getList(1, 200, `node_id = "${nodeId}"`);
  }

  async listByClaim(claimId: string): Promise<ListResult<StorageClaimAudit>> {
    return this.getList(1, 200, `claim_id = "${claimId}"`);
  }

  /** Everything recorded for one (user, node) pair, newest first. */
  async listByUserAndNode(
    userId: string,
    nodeId: string
  ): Promise<ListResult<StorageClaimAudit>> {
    return this.getList(1, 200, [
      `user_id = "${userId}"`,
      `node_id = "${nodeId}"`,
    ]);
  }

  /** Paged, filtered browse for the admin ledger page. */
  async search(
    page: number,
    perPage: number,
    query: ClaimAuditQuery = {}
  ): Promise<ListResult<StorageClaimAudit>> {
    const filters: string[] = [];
    if (query.userId) filters.push(`user_id = "${query.userId}"`);
    if (query.nodeId) filters.push(`node_id = "${query.nodeId}"`);
    if (query.claimId) filters.push(`claim_id = "${query.claimId}"`);
    if (query.action) filters.push(`action = "${query.action}"`);
    return this.getList(page, perPage, filters);
  }
}
