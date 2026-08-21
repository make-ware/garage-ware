import 'server-only';
import { z } from 'zod';
import {
  GarageAuthError,
  GarageClient,
  GarageError,
  blocks,
  cluster,
} from '@/lib/garage';
import { NodeKeyParamSchema, resolveNodeKey } from '@/lib/garage/node-resolve';
import { errorResponse, requireAdmin } from '@/lib/auth/server';
import { writeTimelineActionRow } from '@/lib/cluster/timeline-write';
import { type NodeKey, nodeKey } from '@/lib/node-label';
import { BLOCK_OPERATIONS } from '@/lib/repair/operations';

export const dynamic = 'force-dynamic';

/**
 * Blocks a node failed to fetch from its peers, and the one-button retry.
 *
 * Under `repairs/` beside `workers/`: `/repairs/workers` set the precedent that
 * the page owns the path, and both are read live. **Neither ever reads
 * `lib/garage/cached.ts`** — which blocks are errored *right now* is not a
 * display question, the same rule that keeps `/admin/status` and every
 * validator off the cache.
 *
 * GET and POST share this file, following `events/route.ts`, and deliberately
 * do **not** live in `repairs/route.ts` where the `RepairAction` enum is: a
 * resync retry is not a repair type and must not acquire an action id. See
 * `BLOCK_OPERATIONS`.
 */

/** How much of a block hash is rendered. Display only — see the boundary test. */
export const BLOCK_HASH_DISPLAY_CHARS = 16;

/**
 * How many errored blocks are returned per node.
 *
 * `ListBlockErrors` has no pagination and no filter, and a node with a dead
 * drive can report millions. The cap is on what crosses this boundary; the
 * untruncated count travels beside it in `totalErrors` and **the card renders
 * "Showing 25 of 41,233"**. A cap that only exists in an unrendered field is
 * the silent all-clear this repo keeps refusing.
 */
export const MAX_BLOCK_ERRORS_PER_NODE = 25;

export interface BlockErrorItem {
  /** Truncated to `BLOCK_HASH_DISPLAY_CHARS`. */
  hash: string;
  refcount: number;
  errorCount: number;
  lastTrySecsAgo: number;
  nextTryInSecs: number;
}

export interface BlockErrorNode {
  /** A node key; Garage keys its envelope by full id, reduced on the way out. */
  nodeId: NodeKey;
  /** Non-null when this node did not answer. Never renders as "0 errors". */
  error: string | null;
  /** The **untruncated** count. `items.length` may be smaller. */
  totalErrors: number;
  items: BlockErrorItem[];
  truncated: boolean;
}

export interface BlockErrorsResponse {
  items: BlockErrorNode[];
  fetchedAt: string;
  perNodeLimit: number;
}

const Query = z.object({
  node: z.string().min(1).max(128).default('*'),
});

/**
 * The order is **ours**, and the card says so.
 *
 * Garage guarantees no ordering on this list. Soonest-retried first, then most
 * failures, puts the blocks Garage is about to work on at the top — but a
 * reader must not take the table for Garage's own priority queue, so the copy
 * beside it names the sort.
 */
function byUrgency(a: BlockErrorItem, b: BlockErrorItem): number {
  return a.lastTrySecsAgo - b.lastTrySecsAgo || b.errorCount - a.errorCount;
}

/**
 * A missing token scope is otherwise indistinguishable from an outage.
 *
 * `client.throwForStatus` maps 401/403 to `GarageAuthError`, which
 * `errorResponse` renders as a fixed "check GARAGE_ADMIN_TOKEN" 502 — advice
 * that sends an operator to a token which is set correctly. Every install
 * predating this release has a token without these two scopes, so this is the
 * *likeliest* failure of this route on day one, and it deserves a message
 * naming the operation and the fix. Local, not a widening of `ApiError`.
 */
function scopeResponse(operation: string): Response {
  return Response.json(
    {
      error:
        `The Garage cluster refused ${operation}. The admin token is probably missing that ` +
        `scope — it was added in this release. Re-issue it with ` +
        `ListBlockErrors,RetryBlockResync included (see the README), or drop this card.`,
    },
    { status: 502 }
  );
}

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const url = new URL(req.url);
    const { node } = Query.parse({
      node: url.searchParams.get('node') ?? undefined,
    });

    const garage = GarageClient.fromEnv();
    const outcomes = await blocks.listBlockErrors(garage, { node });

    const items: BlockErrorNode[] = outcomes.map((o) => {
      // A per-node failure is a row, never an HTTP error: one dead node must
      // not blank the card for the rest of the cluster.
      if (!o.ok) {
        return {
          nodeId: nodeKey(o.nodeId),
          error: o.error,
          totalErrors: 0,
          items: [],
          truncated: false,
        };
      }
      const all: BlockErrorItem[] = o.value.map((e) => ({
        // Truncation #2, and a different thing entirely from the cap above:
        // display width. A block hash is **not** a credential — the full-node-id
        // rule exists because an id's last 48 characters are the proof of access
        // `/nodes/owners` accepts, and a block hash unlocks nothing.
        hash: e.blockHash.slice(0, BLOCK_HASH_DISPLAY_CHARS),
        refcount: e.refcount,
        errorCount: e.errorCount,
        lastTrySecsAgo: e.lastTrySecsAgo,
        nextTryInSecs: e.nextTryInSecs,
      }));
      all.sort(byUrgency);
      return {
        nodeId: nodeKey(o.nodeId),
        error: null,
        totalErrors: all.length,
        items: all.slice(0, MAX_BLOCK_ERRORS_PER_NODE),
        truncated: all.length > MAX_BLOCK_ERRORS_PER_NODE,
      };
    });

    const body: BlockErrorsResponse = {
      items,
      fetchedAt: new Date().toISOString(),
      perNodeLimit: MAX_BLOCK_ERRORS_PER_NODE,
    };
    return Response.json(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof GarageAuthError) return scopeResponse('ListBlockErrors');
    if (err instanceof GarageError && err.code === 'timeout') {
      // "Garage did not respond in time" would read as an outage. On this one
      // endpoint the likeliest cause is the opposite — a node with so many
      // errored blocks that the unpaginated list could not be read inside the
      // raised deadline, which is itself the finding.
      return Response.json(
        {
          error:
            'A node reported more errored blocks than could be read in time. ' +
            'That usually means a failed drive with a very large backlog — ' +
            'check the node itself, and `garage block list-errors` on a cluster host.',
        },
        { status: 503 }
      );
    }
    return errorResponse(err);
  }
}

/**
 * The body carries **no `action` parameter at all**.
 *
 * The path is the operation, so there is no enum a caller could smuggle a
 * different one into — the same protection `REPAIR_TYPE_FOR_ACTION` gives the
 * launch route, achieved by having nothing to choose. `all: z.literal(true)`
 * rather than the wire schema's `z.boolean()` because policy belongs to the
 * route; a body carrying `blockHashes` is a 400, not a narrower retry, because
 * per-hash retry would need this route to carry full hashes and that is a
 * boundary to re-argue rather than to edit around.
 */
const Body = z.strictObject({
  nodeId: NodeKeyParamSchema,
  all: z.literal(true),
});

export interface RetryBlockResyncResponse {
  ok: true;
  /** The node key that was named, echoed back — never the resolved full id. */
  nodeId: NodeKey;
  count: number;
  /** False when the retry ran but the timeline entry could not be written. */
  logged: boolean;
}

/**
 * Re-queue every errored block on one node.
 *
 * Same shape as `POST /next-api/garage/repairs`: Garage first, the timeline row
 * second, a refused attempt recorded too, a PocketBase failure surfaced as
 * `logged: false` rather than as a failed request. The one departure is
 * `detail` — on success it carries the count, because that number is the only
 * information the operation produces and is the fact wanted three weeks later.
 * It does **not** go in `new_value`, which stays the raw op id `retry-resync`.
 */
export async function POST(req: Request) {
  try {
    const { user } = await requireAdmin(req);
    const { nodeId } = Body.parse(await req.json());

    const garage = GarageClient.fromEnv();

    // Key -> full id against a live layout, byte for byte the launch route's
    // arrangement: 404 for an unknown node and 409 for an ambiguous key surface
    // as themselves.
    const layout = await cluster.getLayout(garage);
    const fullNodeId = resolveNodeKey(layout, nodeId);

    let outcome: Awaited<ReturnType<typeof blocks.retryBlockResync>> = null;
    let thrown: unknown = null;
    try {
      outcome = await blocks.retryBlockResync(garage, {
        nodeId: fullNodeId,
        request: { all: true },
      });
    } catch (err) {
      thrown = err;
    }

    const copy = BLOCK_OPERATIONS['retry-resync'];
    const succeeded = outcome?.ok === true;
    const count = outcome?.ok === true ? outcome.value.count : 0;
    const failure =
      thrown instanceof Error
        ? thrown.message
        : outcome?.ok === false
          ? outcome.error
          : null;
    const detail = succeeded
      ? `${count.toLocaleString('en-US')} blocks re-queued for resync`
      : (failure ??
        'Garage returned no result for this node — the retry may not have run.');

    const logged = await writeTimelineActionRow({
      kind: 'repair',
      logLabel: '[repairs] block resync retried but',
      nodeId,
      newValue: 'retry-resync',
      title: succeeded ? copy.launched : copy.failed,
      severity: succeeded ? 'info' : 'warning',
      detail,
      actorId: user.id,
      actorEmail: user.email ?? '',
    });

    // Rethrown after the row lands, so `errorResponse` still maps a GarageError
    // to its proper status rather than flattening every cause into one 502.
    if (thrown) {
      if (thrown instanceof GarageAuthError)
        return scopeResponse('RetryBlockResync');
      throw thrown;
    }

    if (!succeeded) {
      return Response.json({ error: detail }, { status: 502 });
    }

    const body: RetryBlockResyncResponse = {
      ok: true,
      nodeId,
      count,
      logged,
    };
    return Response.json(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof GarageAuthError)
      return scopeResponse('RetryBlockResync');
    return errorResponse(err);
  }
}
