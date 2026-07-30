import 'server-only';
import {
  StorageClaimMutator,
  StorageTransferMutator,
} from '@garage-ware/shared/mutators';
import type { ClusterLayout } from '@/lib/garage';
import type { TypedPocketBase } from '@/lib/types';

export interface GrantedOptions {
  /**
   * If true, ignore claims pointing at nodes that are no longer present
   * in the supplied cluster layout. Used by bucket-quota validators to
   * avoid counting phantom capacity from decommissioned nodes.
   */
  onlyPresent?: boolean;
  /** Required when `onlyPresent` is true. */
  layout?: ClusterLayout;
}

/**
 * Net granted GB for a user: direct node claims + received transfers - sent transfers.
 * The onlyPresent filter applies only to claims; transfers are node-agnostic.
 */
export async function getUserGrantedGb(
  pb: TypedPocketBase,
  userId: string,
  options: GrantedOptions = {}
): Promise<number> {
  const claims = new StorageClaimMutator(pb);
  const transfers = new StorageTransferMutator(pb);

  const [claimsGb, receivedGb, sentGb] = await Promise.all([
    (async () => {
      if (!options.onlyPresent) {
        return claims.sumByUser(userId);
      }
      if (!options.layout) {
        throw new Error(
          'getUserGrantedGb: layout required when onlyPresent is true'
        );
      }
      const presentIds = new Set(options.layout.roles.map((r) => r.id));
      const result = await claims.listByUser(userId);
      return result.items
        .filter((c) => presentIds.has(c.node_id))
        .reduce((sum, c) => sum + (Number(c.quota_gb) || 0), 0);
    })(),
    transfers.sumReceivedByUser(userId),
    transfers.sumSentByUser(userId),
  ]);

  return claimsGb + receivedGb - sentGb;
}
