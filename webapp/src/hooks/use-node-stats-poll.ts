'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import type {
  NodeStatsItem,
  NodeStatsResponse,
} from '@/app/next-api/garage/repairs/node-stats/route';

/**
 * The **only** browser timer in this app, and the conditions under which it is
 * allowed to exist.
 *
 * `use-repair-data`'s docblock used to say this app has no timer-driven Garage
 * traffic outside the PocketBase scrape. That is no longer true, and the
 * asymmetry is worth stating rather than deleting: `ListWorkers?node=*` fans
 * out to every peer and returns every worker's full state including prose — a
 * reading you take when you want one, never on a timer.
 * `GetNodeStatistics?node=*` returns three integers per node — a counter you
 * watch. Only the second is polled, and only under all four of these:
 *
 *  - **Only while something is moving.** `active` is `resyncQueueLen > 0` on
 *    some node, or a busy worker. The queue length is its own stop condition:
 *    when it drains, polling stops, with no guessing at worker names — which
 *    are not in the OpenAPI spec at all (`scrub-status.ts` says so), and a real
 *    node may carry a permanently-busy background worker.
 *  - **Only while the tab is visible.** The operator who leaves this page open
 *    overnight is the entire risk this hook has to answer for.
 *  - **A re-arming `setTimeout` chain, never `setInterval`.** A 12-second
 *    fan-out under a 10-second interval stacks requests for ever. The next tick
 *    is scheduled when the previous one settles, so there is exactly one
 *    request in flight however slow the cluster is.
 *  - **Stopping after three consecutive failures.** Hammering a broken cluster
 *    for hours while showing a stale number is worse than saying you stopped.
 *
 * One fan-out on mount is unconditional — opening a page and reading it once is
 * not a timer — so the column is populated even for a cluster at rest.
 */

/** Named, so the UI copy and the tests read the same number. */
export const NODE_STATS_POLL_MS = 10_000;

/** Consecutive failures after which the loop gives up. */
export const NODE_STATS_MAX_FAILURES = 3;

export type PollStoppedReason = 'errors' | null;

export interface NodeStatsPoll {
  statsByNode: Map<string, NodeStatsItem>;
  /** True while the loop is armed — drives the "live" badge. */
  polling: boolean;
  lastPolledAt: string | null;
  stoppedReason: PollStoppedReason;
}

export function useNodeStatsPoll({
  busyWorkers,
}: {
  /**
   * The half of the trigger this hook cannot see: a worker is busy somewhere.
   *
   * The other half — a non-empty resync queue — is computed here, from the
   * hook's own readings, because a caller cannot compute it without the data
   * the hook is fetching. It is also the self-limiting half: `busyWorkers` may
   * be permanently true on a node with a long-lived background worker, while a
   * queue that drains is an unambiguous stop.
   */
  busyWorkers: boolean;
}): NodeStatsPoll {
  const [statsByNode, setStatsByNode] = useState<Map<string, NodeStatsItem>>(
    () => new Map()
  );
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [stoppedReason, setStoppedReason] = useState<PollStoppedReason>(null);

  const queueMoving = [...statsByNode.values()].some(
    (s) => (s.resyncQueueLen ?? 0) > 0
  );
  const active = busyWorkers || queueMoving;

  // Read inside the loop rather than closed over, so the running chain always
  // sees the current values rather than the ones it was created with.
  //
  // Mirrored in an effect rather than assigned during render: `react-hooks/refs`
  // refuses the latter, and this effect is declared **before** the loop's, so
  // React runs it first and the loop never reads a stale value on the render
  // that changed it.
  const activeRef = useRef(active);
  const stoppedRef = useRef<PollStoppedReason>(null);
  /** The mount read happens once per hook instance, not once per re-arm. */
  const didInitialFetch = useRef(false);

  useEffect(() => {
    activeRef.current = active;
    stoppedRef.current = stoppedReason;
  }, [active, stoppedReason]);

  const fetchOnce = useCallback(
    () => api<NodeStatsResponse>('/next-api/garage/repairs/node-stats'),
    []
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const clear = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = () => {
      clear();
      // Never scheduled while hidden: the visibility listener re-arms on the
      // way back rather than leaving a timer running behind a hidden tab.
      if (cancelled || !activeRef.current || document.hidden) return;
      if (stoppedRef.current !== null) return;
      timer = setTimeout(() => {
        void tick();
      }, NODE_STATS_POLL_MS);
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const resp = await fetchOnce();
        if (cancelled) return;
        failures = 0;
        setStatsByNode(new Map(resp.items.map((i) => [i.nodeId, i])));
        setLastPolledAt(resp.fetchedAt);
        setStoppedReason(null);
        stoppedRef.current = null;
      } catch {
        if (cancelled) return;
        failures += 1;
        if (failures >= NODE_STATS_MAX_FAILURES) {
          // Refreshing the page is the way back, deliberately: whatever broke
          // is unlikely to fix itself inside ten seconds, and the badge says so.
          setStoppedReason('errors');
          stoppedRef.current = 'errors';
          clear();
          return;
        }
      }
      schedule();
    };

    const onVisibility = () => {
      if (cancelled) return;
      if (document.hidden) {
        clear();
        return;
      }
      // Back in view: answer immediately rather than after a full interval,
      // because the number on screen is as old as the tab has been hidden.
      if (activeRef.current && stoppedRef.current === null) void tick();
    };

    if (!didInitialFetch.current) {
      // One fan-out when the page opens. Reading a page once is not a timer,
      // and without it the column would be empty on a cluster at rest.
      didInitialFetch.current = true;
      void tick();
    } else if (activeRef.current) {
      // Re-armed because `active` flipped — an operation has started. The first
      // tick is one interval away rather than immediate: nothing has moved yet.
      schedule();
    }
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clear();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchOnce, active]);

  return {
    // Derived, not tracked: a fourth piece of state that has to be kept in
    // agreement with the timer is a fourth way for the badge to lie.
    polling: active && stoppedReason === null,
    statsByNode,
    lastPolledAt,
    stoppedReason,
  };
}
