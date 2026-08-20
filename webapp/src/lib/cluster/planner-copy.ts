import { formatCapacity } from '@/lib/format';
import type { SimFailure, SimWarning } from './layout-sim';

/**
 * Every sentence the planner says about its own limits, in one place.
 *
 * The disclaimers are the feature, not decoration around it: a planner whose
 * per-node numbers can differ from Garage's and does not say so is a planner
 * that will be quoted back as fact. Exported as constants so the page renders
 * exactly what the tests assert, the convention `data-coverage.ts` and
 * `scrub-status.ts` already follow.
 */

export const APPROXIMATION_DISCLAIMER =
  'This is a simulation, and an approximation. The partition size and the ' +
  'effective capacity below reproduce Garage’s own arithmetic exactly; the ' +
  'per-node split is an estimate, because Garage picks among several equally ' +
  'optimal assignments and this page cannot know which one it will choose. ' +
  'Confirm any plan with `garage layout show` before you rely on it.';

export const NO_WRITE_NOTICE =
  'Nothing here is written to Garage, and nothing is staged. Garage can only ' +
  'preview changes that have already been staged, and `garage layout revert` ' +
  'is not an undo — it clears the staging area by incrementing the layout ' +
  'version. So the planner computes locally and hands you the commands.';

export const STAGED_CHANGES_NOTICE =
  'This cluster has staged layout changes pending. The partition size Garage ' +
  'reports describes the layout that is applied, not the staged one, so the ' +
  'accuracy check below is meaningless until those changes are applied or ' +
  'reverted.';

/** The fix the Garage documentation gives for the zero-partition case. */
export const EXAMPLE_ONE_ADVICE =
  'Declaring half the capacity on each node in that zone lets them share the ' +
  'zone’s partitions. The cluster stores the same amount either way — the ' +
  'other zones still bound the total — but the data is spread over both ' +
  'disks instead of sitting on one.';

export function warningTitle(warning: SimWarning): string {
  return warning.kind === 'zero-partition-node'
    ? `${warning.subject} would store nothing`
    : `${warning.zone} declares more capacity than it can use`;
}

export function warningBody(warning: SimWarning): string {
  if (warning.kind === 'zero-partition-node') {
    return (
      `${warning.subject} declares ${formatCapacity(warning.declaredCapacityBytes)} ` +
      `in ${warning.zone} but would be assigned 0 partitions, so it would hold 0 B. ` +
      'The other zones still bound how much the cluster can store, so moving ' +
      'data onto this node would buy no capacity — and Garage will not pay ' +
      'for data movement that gains nothing. ' +
      EXAMPLE_ONE_ADVICE
    );
  }
  const wastedBytes =
    warning.declaredCapacityBytes - warning.usableCapacityBytes;
  return (
    `${warning.zone} declares ${formatCapacity(warning.declaredCapacityBytes)} ` +
    `but only ${formatCapacity(warning.usableCapacityBytes)} of it can be used, ` +
    `leaving ${formatCapacity(wastedBytes)} idle. A zone can never hold more ` +
    'than its share of the ring, so capacity beyond what the smallest zones ' +
    'can match is unreachable. Growing the zones marked as limiting below is ' +
    'what raises the total.'
  );
}

/** The Garage-equivalent message for a topology that has no layout. */
export function failureMessage(failure: SimFailure): string {
  const { detail } = failure;
  switch (failure.reason) {
    case 'not-enough-nodes':
      return (
        `A replication factor of ${detail.replicationFactor} needs at least ` +
        `${detail.replicationFactor} nodes with declared capacity; this plan has ` +
        `${detail.storageNodeCount}. Gateways store nothing and do not count.`
      );
    case 'not-enough-zones':
      return (
        `Zone redundancy “at least ${detail.requestedZoneRedundancy}” needs ` +
        `${detail.requestedZoneRedundancy} distinct zones; this plan has ` +
        `${detail.storageZoneCount}.`
      );
    case 'invalid-redundancy':
      return (
        `Zone redundancy must be between 1 and the replication factor ` +
        `(${detail.replicationFactor}).`
      );
    case 'capacity-too-small':
      return (
        'There is not enough declared capacity to give every partition even ' +
        'one byte on every replica. Add capacity, add nodes, or lower the ' +
        'replication factor.'
      );
    case 'capacity-out-of-range':
      return (
        'The total declared capacity is beyond the precision this calculator ' +
        'can work in (about 9 PB). It will not guess.'
      );
  }
}
