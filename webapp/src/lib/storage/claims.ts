import 'server-only';
import type { ClusterLayout } from '@/lib/garage';
import { computeSummaryFromBalances } from '@/lib/storage/ledger-math';
import { getUserBalances } from '@/lib/storage/balances';
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
 *
 * Reads the materialized balances rather than summing the ledger, so it stays
 * correct past the page sizes the raw sums were capped at.
 */
export async function getUserGrantedGb(
  pb: TypedPocketBase,
  userId: string,
  options: GrantedOptions = {}
): Promise<number> {
  if (options.onlyPresent && !options.layout) {
    throw new Error(
      'getUserGrantedGb: layout required when onlyPresent is true'
    );
  }

  const { nodeBalances, userBalance } = await getUserBalances(pb, userId);
  const summary = computeSummaryFromBalances(
    nodeBalances,
    userBalance,
    options.onlyPresent ? options.layout : undefined
  );
  return summary.netGrantedGb;
}
