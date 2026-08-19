'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';

/**
 * The deployment's feature flags, fetched at runtime from
 * `/next-api/config/features`.
 *
 * Same idiom as `usePricingConfig()` — one in-flight/resolved promise shared by
 * every consumer for the tab's lifetime, cleared on failure so a later mount
 * retries — and it likewise never reports null: state seeds at ALL-OFF, so a
 * failed fetch hides the gated UI rather than flashing it. The routes enforce
 * the flags regardless; this only decides what renders.
 */

export interface FeatureFlags {
  nodeClaims: boolean;
  assetClaims: boolean;
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  nodeClaims: false,
  assetClaims: false,
};

let cached: Promise<FeatureFlags> | null = null;

export function fetchFeatureFlags(): Promise<FeatureFlags> {
  if (!cached) {
    cached = api<FeatureFlags>('/next-api/config/features')
      .then((r) => ({
        nodeClaims: r.nodeClaims === true,
        assetClaims: r.assetClaims === true,
      }))
      .catch((err) => {
        cached = null;
        throw err;
      });
  }
  return cached;
}

export interface UseFeatures {
  /** Never null — all-off stands in until the fetch resolves, or if it fails. */
  features: FeatureFlags;
  /** True once a real server answer replaced the all-off seed. */
  loaded: boolean;
  error: string | null;
}

export function useFeatures(): UseFeatures {
  const [features, setFeatures] = useState<FeatureFlags>(DEFAULT_FEATURE_FLAGS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const f = await fetchFeatureFlags();
        if (!cancelled) {
          setFeatures(f);
          setLoaded(true);
        }
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : 'Failed to load feature flags'
          );
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { features, loaded, error };
}
