import 'server-only';
import { z } from 'zod';
import { GarageClient, repair } from '@/lib/garage';
import { errorResponse, requireAdmin } from '@/lib/auth/server';
import {
  describeWorkerState,
  findScrubWorker,
  parseScrubStatus,
  type FlatWorkerState,
  type ScrubStatus,
} from '@/lib/repair/scrub-status';

export const dynamic = 'force-dynamic';

/**
 * Background-worker state for every node, live.
 *
 * **One fetch serves all three repair pages.** The scrub page reads `scrub`;
 * the blocks and rebalance pages read `busyCount` / `erroredCount`, which is
 * how they can tell an operator "a worker is already busy on this node" before
 * they launch a second long-running job — the most useful thing those pages can
 * say, and it costs nothing extra.
 *
 * **This never reads `lib/garage/cached.ts`**, and must not start. Worker state
 * is live operational state; "can this repair run *now*" is not a display
 * question, which is the same rule that keeps /admin/status off the cache.
 *
 * It returns no node identity either — zone, tags and names come from
 * /next-api/garage/cluster/nodes, which the pages already fetch and which is
 * cached and cheap. Node labelling stays in exactly one place.
 */

export interface RepairWorkerItem {
  id: number;
  name: string;
  /** The spec's untagged state union, already flattened. See `describeWorkerState`. */
  state: FlatWorkerState;
  throttledSecs: number | null;
  progress: string | null;
  queueLength: number | null;
  tranquility: number | null;
  errors: number;
  consecutiveErrors: number;
  lastError: { message: string; secsAgo: number } | null;
  freeform: string[];
}

export interface RepairNodeWorkers {
  nodeId: string;
  /** Non-null when this node did not answer. A row must never read as idle instead. */
  error: string | null;
  workers: RepairWorkerItem[];
  /** Every worker name the node reported — what the UI shows when no scrub worker matched. */
  workerNames: string[];
  scrub: ScrubStatus | null;
  busyCount: number;
  erroredCount: number;
}

export interface RepairWorkersResponse {
  items: RepairNodeWorkers[];
  /** So the page can say how stale the reading is; there is no polling. */
  fetchedAt: string;
}

const Query = z.object({
  node: z.string().min(1).max(128).default('*'),
});

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const url = new URL(req.url);
    const { node } = Query.parse({
      node: url.searchParams.get('node') ?? undefined,
    });

    const garage = GarageClient.fromEnv();
    const outcomes = await repair.listWorkers(garage, { node });

    const items: RepairNodeWorkers[] = outcomes.map((o) => {
      if (!o.ok) {
        return {
          nodeId: o.nodeId,
          error: o.error,
          workers: [],
          workerNames: [],
          scrub: null,
          busyCount: 0,
          erroredCount: 0,
        };
      }
      const workers: RepairWorkerItem[] = o.value.map((w) => {
        const { state, throttledSecs } = describeWorkerState(w.state);
        return {
          id: w.id,
          name: w.name,
          state,
          throttledSecs,
          progress: w.progress ?? null,
          queueLength: w.queueLength ?? null,
          tranquility: w.tranquility ?? null,
          errors: w.errors,
          consecutiveErrors: w.consecutiveErrors,
          lastError: w.lastError ?? null,
          freeform: w.freeform ?? [],
        };
      });
      const scrubWorker = findScrubWorker(o.value);
      return {
        nodeId: o.nodeId,
        error: null,
        workers,
        workerNames: o.value.map((w) => w.name),
        scrub: scrubWorker ? parseScrubStatus(scrubWorker) : null,
        busyCount: workers.filter((w) => w.state === 'busy').length,
        erroredCount: workers.filter((w) => w.consecutiveErrors > 0).length,
      };
    });

    const body: RepairWorkersResponse = {
      items,
      fetchedAt: new Date().toISOString(),
    };
    return Response.json(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
