'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';

/**
 * Public S3 gateway config, fetched at runtime from `/next-api/config` (which
 * reads the server-side `GARAGE_S3_ENDPOINT` / `GARAGE_S3_REGION` env). Runtime
 * rather than build-time (`NEXT_PUBLIC_*`) so a single image can be deployed to
 * any cluster and pointed at its gateway via env, with no rebuild.
 */
export interface S3Config {
  /**
   * S3 gateway endpoint used by the in-app file browser's S3 client, which signs
   * requests in the browser and so needs CORS configured for this app's origin.
   * Comes from `GARAGE_S3_ENDPOINT`.
   */
  endpoint: string;
  /**
   * Endpoint shown on the bucket "connect" page for users to paste into their
   * own S3 tools. Comes from `GARAGE_PUBLIC_S3_ENDPOINT`, falling back to
   * `endpoint` (`GARAGE_S3_ENDPOINT`) when that env is unset.
   */
  publicEndpoint: string;
  /** S3 region, e.g. `us-east-1`. */
  region: string;
}

interface ConfigResponse {
  s3Endpoint: string;
  s3PublicEndpoint: string;
  s3Region: string;
}

// One in-flight/resolved request shared by every consumer for the tab's
// lifetime — the config never changes while the page is open. Cleared on
// failure so a later mount can retry.
let cached: Promise<S3Config> | null = null;

export function fetchS3Config(): Promise<S3Config> {
  if (!cached) {
    cached = api<ConfigResponse>('/next-api/config')
      .then((r) => ({
        endpoint: r.s3Endpoint,
        publicEndpoint: r.s3PublicEndpoint,
        region: r.s3Region,
      }))
      .catch((err) => {
        cached = null;
        throw err;
      });
  }
  return cached;
}

export interface UseS3Config {
  config: S3Config | null;
  error: string | null;
}

/** Fetch the S3 config once on mount. `config` is null until it resolves. */
export function useS3Config(): UseS3Config {
  const [config, setConfig] = useState<S3Config | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const c = await fetchS3Config();
        if (!cancelled) setConfig(c);
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : 'Failed to load S3 config'
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
