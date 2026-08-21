'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api-client';
import { buildNodeNameMap, nodeLabel } from '@/lib/node-label';
import type { ClusterNodesResponse } from '@/lib/types';
import type {
  RepairNodeWorkers,
  RepairWorkersResponse,
} from '@/app/next-api/garage/repairs/workers/route';

/**
 * The node list joined to its live worker state, for every page under
 * /admin/repairs.
 *
 * **The node list is the spine; worker state is enrichment.** The workers fetch
 * is caught to null, because this is the page an operator opens *because* the
 * cluster looks sick — a cluster that cannot report worker state can still be
 * repaired, and a page refusing to render because the reading failed would
 * withhold the controls exactly when they are wanted. Same trade
 * /dashboard/metrics makes, with the roles reversed.
 *
 * **This hook does not poll, and must not start.** `ListWorkers?node=*` fans
 * out to every peer and brings back every worker's full state including prose;
 * a tab left open would do that for ever. A manual refresh plus an automatic
 * one after a launch, with `fetchedAt` on screen so the operator knows how old
 * the reading is.
 *
 * **One hook in this app does poll**, and naming the asymmetry is the point:
 * `use-node-stats-poll.ts` calls `GetNodeStatistics` — three integers per node
 * — only while a resync queue is non-empty or a worker is busy, only while the
 * tab is visible, and it stops after three consecutive failures. A counter you
 * watch, against a reading you take. When adding a Garage call, decide which of
 * the two it is before deciding whether it may be on a timer.
 */
export interface RepairNodeRow {
  nodeId: string;
  name: string | null;
  label: string;
  zone: string;
  isUp: boolean | null;
  draining: boolean | null;
  /** Null when the workers fetch failed outright, or the node wasn't mentioned. */
  workers: RepairNodeWorkers | null;
}

export function useRepairData() {
  const [nodes, setNodes] = useState<ClusterNodesResponse | null>(null);
  const [workers, setWorkers] = useState<RepairWorkersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nodesResp, workersResp] = await Promise.all([
      api<ClusterNodesResponse>('/next-api/garage/cluster/nodes'),
      api<RepairWorkersResponse>('/next-api/garage/repairs/workers').catch(
        () => null
      ),
    ]);
    return { nodesResp, workersResp };
  }, []);

  const apply = useCallback(
    (
      nodesResp: ClusterNodesResponse,
      workersResp: RepairWorkersResponse | null
    ) => {
      setNodes(nodesResp);
      setWorkers(workersResp);
      setError(null);
    },
    []
  );

  const refresh = useCallback(async () => {
    const { nodesResp, workersResp } = await load();
    apply(nodesResp, workersResp);
  }, [load, apply]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const { nodesResp, workersResp } = await load();
        if (cancelled) return;
        apply(nodesResp, workersResp);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load nodes');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [load, apply]);

  const rows = useMemo<RepairNodeRow[]>(() => {
    const names = buildNodeNameMap(
      (nodes?.items ?? []).map((n) => ({ id: n.id, tags: n.tags }))
    );
    const workersByNode = new Map(
      (workers?.items ?? []).map((w) => [w.nodeId, w])
    );

    // The union of both sources. A node in the layout that did not answer must
    // still get a row — silence is a diagnosis, not an absence — and a node id
    // that only appears in the envelope gets a short-id row rather than being
    // dropped on the floor.
    const ids = new Set<string>([
      ...(nodes?.items ?? []).map((n) => n.id),
      ...(workers?.items ?? []).map((w) => w.nodeId),
    ]);
    const nodeById = new Map((nodes?.items ?? []).map((n) => [n.id, n]));

    return [...ids]
      .map((id) => {
        const n = nodeById.get(id);
        const name = names.get(id) ?? null;
        return {
          nodeId: id,
          name,
          label: nodeLabel(name, id),
          zone: n?.zone ?? '',
          isUp: n?.isUp ?? null,
          draining: n?.draining ?? null,
          workers: workersByNode.get(id) ?? null,
        };
      })
      .sort(
        (a, b) => a.zone.localeCompare(b.zone) || a.label.localeCompare(b.label)
      );
  }, [nodes, workers]);

  return {
    rows,
    loading,
    error,
    /** True when the node list loaded but worker state could not be read. */
    workersUnavailable: !loading && !error && workers === null,
    fetchedAt: workers?.fetchedAt ?? null,
    refresh,
  };
}
