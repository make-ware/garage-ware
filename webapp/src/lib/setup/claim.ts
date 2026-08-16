import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * First-run ownership.
 *
 * The `Admins` collection gates its own creation — `@collection.Admins.user ?=
 * @request.auth.id` means you must already be an admin to make one — so the
 * first admin cannot be created through the app at all. Before this, the only
 * route was `seed-admin.mjs`, which the Docker image did not even ship.
 *
 * The claim token closes that gap without opening a hole: whoever can read the
 * container's logs (or its /data volume) can claim the instance once. The
 * load-bearing guard is NOT the token's secrecy, it is
 * {@link assertUnclaimed} — a token is only ever accepted while no admin
 * exists, so a leaked one is inert the moment the instance is claimed.
 */

/** Where the entrypoint keeps first-run state. */
export function setupStateDir(): string {
  return process.env.SETUP_STATE_DIR ?? '/data/setup';
}

function claimTokenPath(): string {
  return path.join(setupStateDir(), 'claim-token');
}

function claimedMarkerPath(): string {
  return path.join(setupStateDir(), 'claimed');
}

/**
 * The token this instance will accept, or null when there is none to accept.
 *
 * `SETUP_CLAIM_TOKEN` wins so a deployment can supply one from a secret manager
 * without the container writing it to a volume.
 */
export async function expectedClaimToken(): Promise<string | null> {
  const fromEnv = process.env.SETUP_CLAIM_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = await readFile(claimTokenPath(), 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Constant-time token comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * expected length, so compare lengths first and then compare equal-length
 * buffers. Both are secrets of our own choosing, so a length check leaking is
 * not meaningful — throwing an unhandled error would be.
 */
export function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Record that ownership has been taken, so the entrypoint stops offering it. */
export async function markClaimed(): Promise<void> {
  try {
    await writeFile(
      claimedMarkerPath(),
      `claimed ${new Date().toISOString()}\n`,
      { mode: 0o600 }
    );
  } catch (err) {
    // Non-fatal: the Admins row is the real state. Losing the marker only means
    // the entrypoint prints a claim token that /setup will refuse anyway.
    console.warn('[setup] could not write claimed marker:', err);
  }
  try {
    await rm(claimTokenPath(), { force: true });
  } catch (err) {
    console.warn('[setup] could not remove claim token file:', err);
  }
}

export interface AdminCounter {
  countAdmins(): Promise<number>;
}

/** Whether anybody holds the admin scope yet. */
export async function isClaimed(counter: AdminCounter): Promise<boolean> {
  return (await counter.countAdmins()) > 0;
}

export type ClaimFailure =
  'already-claimed' | 'no-token-configured' | 'bad-token';

export interface ClaimOutcome {
  ok: boolean;
  failure?: ClaimFailure;
}

/**
 * Decide whether a claim attempt should be honoured.
 *
 * Split out from the route handler so the ordering — claimed check *before*
 * token check — is testable. That order matters: once an instance is claimed,
 * it must answer identically whether or not the caller guessed the token.
 */
export async function evaluateClaim(
  counter: AdminCounter,
  suppliedToken: string
): Promise<ClaimOutcome> {
  if (await isClaimed(counter)) {
    return { ok: false, failure: 'already-claimed' };
  }
  const expected = await expectedClaimToken();
  if (!expected) {
    return { ok: false, failure: 'no-token-configured' };
  }
  if (!tokenMatches(suppliedToken, expected)) {
    return { ok: false, failure: 'bad-token' };
  }
  return { ok: true };
}

/** Human-readable reason + HTTP status for a refused claim. */
export function describeFailure(failure: ClaimFailure): {
  status: number;
  error: string;
} {
  switch (failure) {
    case 'already-claimed':
      return {
        status: 409,
        error:
          'This instance already has an administrator. Ask them to grant you access from the admin console.',
      };
    case 'no-token-configured':
      return {
        status: 409,
        error:
          'No claim token is configured on this deployment. Restart the container and read the [setup] banner in its logs, or grant the admin scope manually with seed-admin.',
      };
    case 'bad-token':
      return { status: 403, error: 'That claim token is not valid.' };
  }
}
