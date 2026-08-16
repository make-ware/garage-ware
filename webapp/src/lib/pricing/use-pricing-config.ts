'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { DEFAULT_PRICING_CONFIG, type PricingConfig } from './rates';

/**
 * The deployment's pricing config, fetched at runtime from
 * `/next-api/config/pricing`.
 *
 * The same idiom as `useS3Config()` — one in-flight/resolved promise shared by
 * every consumer for the tab's lifetime, cleared on failure so a later mount
 * retries — with one deliberate difference: **this hook never reports a null
 * config.** It starts at, and falls back to, `DEFAULT_PRICING_CONFIG`. The cost
 * card is enrichment on a dashboard that has plenty else to show, and every
 * value it needs has a documented default, so a failed fetch should cost the
 * reader an accurate hardware cost, not the whole panel. `error` is still
 * returned for anything that wants to say so.
 */

interface PricingConfigResponse {
  garageUsdPerTb: number;
  hardwareLifespanYears: number;
  ratesAsOf: string;
}

let cached: Promise<PricingConfig> | null = null;

export function fetchPricingConfig(): Promise<PricingConfig> {
  if (!cached) {
    cached = api<PricingConfigResponse>('/next-api/config/pricing')
      .then((r) => ({
        garageUsdPerTb: r.garageUsdPerTb,
        hardwareLifespanYears: r.hardwareLifespanYears,
      }))
      .catch((err) => {
        cached = null;
        throw err;
      });
  }
  return cached;
}

export interface UsePricingConfig {
  /** Never null — the defaults stand in until the fetch resolves, or if it fails. */
  config: PricingConfig;
  error: string | null;
}

export function usePricingConfig(): UsePricingConfig {
  const [config, setConfig] = useState<PricingConfig>(DEFAULT_PRICING_CONFIG);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const c = await fetchPricingConfig();
        if (!cancelled) setConfig(c);
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : 'Failed to load pricing config'
          );
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { config, error };
}
