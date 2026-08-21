'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import type { BlockErrorsResponse } from '@/app/next-api/garage/repairs/block-errors/route';

/**
 * Blocks that failed to resync, per node.
 *
 * **Enrichment, not the page** — the same stance `use-repair-data` takes with
 * worker state, and for a sharper reason here: on an install whose admin token
 * predates this release, `ListBlockErrors` is refused for want of a scope, and
 * a repairs page that refused to render because of it would withhold every
 * repair control over a card that is empty on a healthy cluster. So the failure
 * is captured as a message and shown inside the card.
 *
 * **No polling.** Block errors change on Garage's own resync schedule, not on a
 * timescale worth a timer; the one browser timer in this app is
 * `use-node-stats-poll` and it exists for a counter that moves every few
 * seconds. Manual refresh, plus one after a retry.
 */
export function useBlockErrors() {
  const [data, setData] = useState<BlockErrorsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<{
    data: BlockErrorsResponse | null;
    error: string | null;
  }> => {
    try {
      const resp = await api<BlockErrorsResponse>(
        '/next-api/garage/repairs/block-errors'
      );
      return { data: resp, error: null };
    } catch (err) {
      return {
        data: null,
        error:
          err instanceof Error ? err.message : 'Could not read block errors',
      };
    }
  }, []);

  const refresh = useCallback(async () => {
    const result = await load();
    setData(result.data);
    setError(result.error);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const result = await load();
      if (cancelled) return;
      setData(result.data);
      setError(result.error);
      setLoading(false);
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [load]);

  return { data, error, loading, refresh };
}
