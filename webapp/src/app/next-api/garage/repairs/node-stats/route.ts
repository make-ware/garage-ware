import 'server-only';
import { z } from 'zod';
import { GarageClient, cluster } from '@/lib/garage';
import { errorResponse, requireAdmin } from '@/lib/auth/server';
import { type NodeKey, nodeKey } from '@/lib/node-label';

export const dynamic = 'force-dynamic';

/**
 * Three integers per node: how far behind each one's block manager is.
 *
 * **This is the only route in the app a browser timer calls** — see
 * `hooks/use-node-stats-poll.ts`, which is the app's single `setTimeout` chain
 * and stops on its own when the queues drain. That is why it is separate from
 * `/repairs/workers`: `ListWorkers?node=*` returns every node's full worker
 * list including prose, and is a reading you take when you want one;
 * `GetNodeStatistics?node=*` returns three numbers, and is a counter you watch.
 * One hook per cost profile is what lets both docblocks stay true.
 *
 * Live, never `cached.ts`, like everything else under `repairs/`.
 *
 * **`freeform` and `tableStats` are dropped.** The spec's own description of
 * `GetNodeStatistics` says not to parse `freeform` — it is kept for
 * compatibility with older v2.x nodes and its format is not stable — and
 * carrying it to the browser is how a second prose parser gets written. This is
 * deliberately the *opposite* of what `/repairs/workers` does with
 * `WorkerInfoResp.freeform`, and the difference is the point: there, prose is
 * the only channel carrying the last-scrub time; here the structured fields
 * exist. `tableStats` is dropped because nothing renders it.
 */

export interface NodeStatsItem {
  nodeId: NodeKey;
  /** Non-null when this node did not answer. A row must not read as "0". */
  error: string | null;
  /**
   * All three are `null` when Garage reported no `blockManagerStats`, and
   * **never `0`**: "not reported" and "the queue is empty" are opposite
   * conclusions, and a `?? 0` anywhere on this path is a bug.
   */
  resyncQueueLen: number | null;
  resyncErrors: number | null;
  rcEntries: number | null;
}

export interface NodeStatsResponse {
  items: NodeStatsItem[];
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
    const outcomes = await cluster.getNodeStatistics(garage, { node });

    const items: NodeStatsItem[] = outcomes.map((o) => {
      if (!o.ok) {
        return {
          nodeId: nodeKey(o.nodeId),
          error: o.error,
          resyncQueueLen: null,
          resyncErrors: null,
          rcEntries: null,
        };
      }
      const bm = o.value.blockManagerStats ?? null;
      return {
        nodeId: nodeKey(o.nodeId),
        error: null,
        resyncQueueLen: bm?.resyncQueueLen ?? null,
        resyncErrors: bm?.resyncErrors ?? null,
        rcEntries: bm?.rcEntries ?? null,
      };
    });

    const body: NodeStatsResponse = {
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
