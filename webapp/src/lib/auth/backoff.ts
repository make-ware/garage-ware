import 'server-only';

/**
 * A shared speed bump for routes that check a secret.
 *
 * Extracted from `next-api/setup/claim/route.ts`, which had the only copy, once
 * `next-api/garage/keys/claim` needed the same thing. Two hand-rolled
 * escalating sleeps would be two chances to get the reset wrong.
 *
 * **Name what this is not.** The counter is process-global rather than per-IP
 * or per-account, so it slows an attacker and every other caller in that
 * process equally, and it does nothing across replicas. It is a speed bump, not
 * a rate limiter, and in neither of its uses is it the defence:
 *
 * - `setup/claim` is defended by refusing outright once an admin exists;
 * - `keys/claim` is defended by the secret being unguessable.
 *
 * What it *is* for is cost. `keys/claim` turns one request into a Garage admin
 * API round trip, so a caller hammering it amplifies into the cluster; making
 * repeated failures progressively slower is the cheap way to bound that.
 *
 * Each caller gets its own counter via {@link createBackoff}, so a burst of
 * wrong key secrets cannot slow down an unrelated route.
 */

/** Longest a single penalty will sleep. */
export const MAX_BACKOFF_MS = 2_000;

const STEP_MS = 250;
const MAX_STEPS = 8;

export interface Backoff {
  /** Sleep for progressively longer on each consecutive failure. */
  penalise(): Promise<void>;
  /** Clear the streak. Call on success. */
  reset(): void;
}

export function createBackoff(): Backoff {
  let consecutiveFailures = 0;
  return {
    async penalise() {
      consecutiveFailures = Math.min(consecutiveFailures + 1, MAX_STEPS);
      const delay = Math.min(consecutiveFailures * STEP_MS, MAX_BACKOFF_MS);
      await new Promise((resolve) => setTimeout(resolve, delay));
    },
    reset() {
      consecutiveFailures = 0;
    },
  };
}
