import 'server-only';
import {
  BucketMutator,
  StorageClaimMutator,
  StorageTransferMutator,
} from '@garage-ware/shared/mutators';
import type { ClusterLayout } from '@/lib/garage';
import type { StorageSummary, TypedPocketBase } from '@/lib/types';

export type { StorageSummary };

/**
 * Compute a complete storage position for a user in one place.
 * When layout is provided, claimsGb filters out decommissioned nodes
 * (same conservative accounting used by bucket-quota validators).
 */
export async function getUserStorageSummary(
  pb: TypedPocketBase,
  userId: string,
  layout?: ClusterLayout
): Promise<StorageSummary> {
  const claimMutator = new StorageClaimMutator(pb);
  const transferMutator = new StorageTransferMutator(pb);
  const bucketMutator = new BucketMutator(pb);

  const [claimsResult, sentResult, receivedResult, allocatedGb] =
    await Promise.all([
      claimMutator.listByUser(userId),
      transferMutator.listSentByUser(userId),
      transferMutator.listReceivedByUser(userId),
      bucketMutator.sumAllocatedGb(userId),
    ]);

  const claims = claimsResult.items;
  const sentTransfers = sentResult.items;
  const receivedTransfers = receivedResult.items;

  const presentIds = layout ? new Set(layout.roles.map((r) => r.id)) : null;

  const claimsGb = claims
    .filter((c) => !presentIds || presentIds.has(c.node_id))
    .reduce((sum, c) => sum + (Number(c.quota_gb) || 0), 0);

  const sentGb = sentTransfers.reduce(
    (sum, t) => sum + (Number(t.quota_gb) || 0),
    0
  );
  const receivedGb = receivedTransfers.reduce(
    (sum, t) => sum + (Number(t.quota_gb) || 0),
    0
  );

  const netGrantedGb = claimsGb + receivedGb - sentGb;
  const availableGb = Math.max(netGrantedGb - allocatedGb, 0);

  return {
    claims,
    sentTransfers,
    receivedTransfers,
    claimsGb,
    sentGb,
    receivedGb,
    netGrantedGb,
    allocatedGb,
    availableGb,
  };
}
