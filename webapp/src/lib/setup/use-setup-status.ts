'use client';

import { useEffect, useState } from 'react';
import type { SignupMode } from './signup-mode';

/**
 * The instance's public setup status, fetched from `/next-api/setup/status`
 * (unauthenticated by necessity — `/` and `/signup` must route a visitor with
 * no account).
 *
 * Same never-null idiom as `useFeatures()`, seeded at the FAIL-SAFE state —
 * claimed and closed — so a failed fetch hides signup surfaces rather than
 * flashing them. `loaded` distinguishes "the defaults are standing in" from
 * "this is what the server said", for the one page (/signup) that should not
 * show a closed-state message off the seed alone.
 */

export interface SetupStatus {
  claimed: boolean;
  signupMode: SignupMode;
}

const FAILSAFE_STATUS: SetupStatus = { claimed: true, signupMode: 'closed' };

let cached: Promise<SetupStatus> | null = null;

export function fetchSetupStatus(): Promise<SetupStatus> {
  if (!cached) {
    cached = fetch('/next-api/setup/status', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Setup status returned ${res.status}`);
        const body = (await res.json()) as {
          claimed?: boolean;
          signupMode?: string;
        };
        return {
          claimed: body.claimed !== false,
          signupMode: (body.signupMode === 'open' ||
          body.signupMode === 'invite'
            ? body.signupMode
            : 'closed') as SignupMode,
        };
      })
      .catch((err) => {
        cached = null;
        throw err;
      });
  }
  return cached;
}

export interface UseSetupStatus {
  /** Never null — fail-safe (claimed, closed) stands in until resolved. */
  status: SetupStatus;
  /** True once a real server answer replaced the fail-safe seed. */
  loaded: boolean;
  error: string | null;
}

export function useSetupStatus(): UseSetupStatus {
  const [status, setStatus] = useState<SetupStatus>(FAILSAFE_STATUS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const s = await fetchSetupStatus();
        if (!cancelled) {
          setStatus(s);
          setLoaded(true);
        }
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : 'Failed to load setup status'
          );
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { status, loaded, error };
}
