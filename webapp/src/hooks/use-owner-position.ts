'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';

export interface OwnerPosition {
  grantedGb: number;
  /** Everything the owner's buckets reserve, the bucket in hand included. */
  allocatedGb: number;
}

/**
 * A bucket owner's storage position, read by id from `/storage-summary`.
 *
 * Fetched here rather than passed in: callers read users from
 * `/next-api/garage/users`, which serves a single 200-row page, so any owner
 * past it arrived as a grant of 0 and the dialog refused every quota as an
 * over-grant.
 *
 * A failed read is reported, not thrown. Callers must treat an unknown position
 * as "let the server validate" rather than as a block — refusing to submit on
 * an unknown grant is how the quota dialog used to dead-end.
 */
export function useOwnerPosition(ownerId: string, active: boolean) {
  const [position, setPosition] = useState<OwnerPosition | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = async () => {
      try {
        const summary = await api<{
          netGrantedGb: number;
          allocatedGb: number;
        }>(
          `/next-api/garage/storage-summary?userId=${encodeURIComponent(ownerId)}`
        );
        if (cancelled) return;
        setPosition({
          grantedGb: summary.netGrantedGb,
          allocatedGb: summary.allocatedGb,
        });
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : 'Could not read the owner grant'
        );
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [active, ownerId]);

  return { position, error, loading: position === null && error === null };
}
