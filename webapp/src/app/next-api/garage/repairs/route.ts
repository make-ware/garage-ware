import 'server-only';
import { z } from 'zod';
import { GarageClient, cluster, repair } from '@/lib/garage';
import { resolveNodeKey } from '@/lib/garage/node-resolve';
import type { NodeKey } from '@/lib/node-label';
import { errorResponse, requireAdmin } from '@/lib/auth/server';
import { writeTimelineActionRow } from '@/lib/cluster/timeline-write';
import { REPAIR_ACTIONS, REPAIR_ACTION_IDS } from '@/lib/repair/operations';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /**
   * A node key — 16 hex characters, what every payload in the app carries.
   *
   * The pattern is what rejects `*`: a wildcard here would fan the repair
   * across every node in the cluster while the operator's confirmation dialog
   * named exactly one. Hex also rejects `self`, which is whichever node answers
   * the admin API and routinely not the one clicked — but the explicit refusal
   * stays, because two guards on the same thing is not one too many, and
   * `launchRepair` makes it three.
   */
  nodeId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{16}$/, 'nodeId must be a 16-character node key')
    .refine((v) => v !== 'self', 'nodeId must name one node, not "self"'),
  action: z.enum(REPAIR_ACTION_IDS),
});

export interface LaunchRepairResponse {
  ok: true;
  /** The node key that was named, echoed back — never the resolved full id. */
  nodeId: NodeKey;
  action: string;
  /** False when the repair ran but the timeline entry could not be written. */
  logged: boolean;
}

/**
 * Launch one Garage repair on one node, and record it on the cluster timeline.
 *
 * **Ordering: Garage first, the ClusterEvents row second — which inverts this
 * repo's usual "PB first, Garage second, roll back on failure" rule, on
 * purpose.** That rule governs *mirrored* state, where a PB row must correspond
 * to a real Garage object (an AccessKeys row and its key). A timeline row is
 * not mirrored state; it is the record that a human pressed a button, and there
 * is nothing to roll back to.
 *
 * Garage has to go first because the row's content depends on the outcome. A
 * row written beforehand could only say "an attempt was made", and correcting
 * it afterwards is impossible by design: ClusterEvents has `updateRule: null`
 * and its PATCH writes only `annotation` and `ended_at`. One row, written once,
 * stating what happened.
 *
 * **A refused launch writes a row too**, at `warning`, with Garage's message in
 * `detail`. "I tried to scrub node 4 and it wouldn't" is exactly the thing an
 * operator needs to find three weeks later.
 *
 * **A PocketBase failure logs and still returns success.** This is the
 * StorageInvites email precedent, and the reasoning transfers exactly: the
 * repair has *already been launched on the cluster*. Failing the request would
 * tell the operator it hadn't, and they would click again — turning a logging
 * outage into a duplicated cluster-wide block repair. `logged: false` is how
 * the page says so instead.
 *
 * **It now makes a layout call**, which an earlier version of this handler
 * deliberately did not. The browser names a node key and Garage's `?node=`
 * takes a full id and nothing else — `lib/garage/node-resolve.ts` explains why
 * guessing that a prefix would work is unsafe — so the key has to be resolved
 * before the call. The read is live, not `cached.ts`: launching a repair is an
 * action, and a stale layout must not decide which node it lands on.
 */
export async function POST(req: Request) {
  try {
    const { user } = await requireAdmin(req);
    const { nodeId, action } = Body.parse(await req.json());

    const garage = GarageClient.fromEnv();

    // Key -> full id. A 404 here (no such node) and a 409 (two nodes sharing a
    // key, which needs a 64-bit collision) both come out of resolveNodeKey as
    // HttpErrors and are reported as themselves. Garage's error map remains the
    // authority on everything *else* about the node.
    const layout = await cluster.getLayout(garage);
    const fullNodeId = resolveNodeKey(layout, nodeId);

    // Two distinct failure shapes, and the row has to be written for both.
    // Garage reports a *per-node* problem in the envelope's `error` map, but
    // rejects a request-level one — an unknown node id, a bad token, an
    // unreachable cluster — with a non-2xx, which `client.request` throws.
    // Verified against a live cluster: an unknown node comes back HTTP 400
    // ("No nodes matching ..."), not an envelope entry. Catching here is what
    // keeps "a refused launch is recorded too" true for the failure modes that
    // actually happen, rather than only the one the spec suggests.
    let outcome: Awaited<ReturnType<typeof repair.launchRepair>> = null;
    let thrown: unknown = null;
    try {
      outcome = await repair.launchRepair(garage, {
        nodeId: fullNodeId,
        action,
      });
    } catch (err) {
      thrown = err;
    }

    const copy = REPAIR_ACTIONS[action];
    const succeeded = outcome?.ok === true;
    const failure =
      thrown instanceof Error
        ? thrown.message
        : outcome?.ok === false
          ? outcome.error
          : null;
    const detail = succeeded
      ? ''
      : (failure ??
        'Garage returned no result for this node — the repair may not have started.');

    const logged = await writeTimelineActionRow({
      kind: 'repair',
      logLabel: '[repairs] repair launched but',
      nodeId,
      newValue: action,
      title: succeeded ? copy.launched : copy.failed,
      severity: succeeded ? 'info' : 'warning',
      detail,
      actorId: user.id,
      actorEmail: user.email ?? '',
    });

    // Rethrown *after* the row lands, so `errorResponse` still maps a
    // GarageError to its proper status — 400 for an unknown node, 503 for an
    // unreachable cluster — instead of flattening every cause into one 502.
    if (thrown) throw thrown;

    if (!succeeded) {
      // 502, not a 200 with `ok:false`. Reporting a failure inside a success
      // body would rebuild, at our own API boundary, the exact trap Garage's
      // multi-node envelope sets. `{ error }` is the shape api() reads.
      return Response.json({ error: detail }, { status: 502 });
    }

    const body: LaunchRepairResponse = { ok: true, nodeId, action, logged };
    return Response.json(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
