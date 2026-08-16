import 'server-only';
import { z } from 'zod';
import { GarageClient, repair } from '@/lib/garage';
import {
  errorResponse,
  getPbAsSuperuser,
  requireAdmin,
} from '@/lib/auth/server';
import { REPAIR_ACTIONS, REPAIR_ACTION_IDS } from '@/lib/repair/operations';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /**
   * The `[A-Za-z0-9._-]+` character class is what rejects `*` — a wildcard here
   * would fan the repair across every node in the cluster while the operator's
   * confirmation dialog named exactly one. `self` is refused separately: it is
   * whichever node answers the admin API, routinely not the one clicked.
   * `launchRepair` guards both again; this is the outer of two.
   */
  nodeId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/, 'nodeId must name one node')
    .refine((v) => v !== 'self', 'nodeId must name one node, not "self"'),
  action: z.enum(REPAIR_ACTION_IDS),
});

export interface LaunchRepairResponse {
  ok: true;
  nodeId: string;
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
 */
export async function POST(req: Request) {
  try {
    const { user } = await requireAdmin(req);
    const { nodeId, action } = Body.parse(await req.json());

    const garage = GarageClient.fromEnv();

    // No layout call: Garage's own error map is the authority on whether this
    // node exists, and fetching the layout would buy a second failure mode for
    // no extra safety.
    //
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
      outcome = await repair.launchRepair(garage, { nodeId, action });
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

    const logged = await writeTimelineRow({
      nodeId,
      action,
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

/**
 * Append the row. Returns whether it landed; never throws.
 *
 * `ended_at` is set equal to `occurred_at`, for two reasons. It is honest — the
 * *launch* is the instant being recorded, and we have no idea when a scrub
 * finishes, so claiming a duration would be a fabrication. And it is belt and
 * braces against the "under repair" marker: that state is
 * `source = "manual" && ended_at = ""`, which `source: 'action'` already
 * excludes, but a row that is closed the moment it opens cannot be caught by a
 * future query that keys on `ended_at` alone either.
 */
async function writeTimelineRow(input: {
  nodeId: string;
  action: string;
  title: string;
  severity: 'info' | 'warning';
  detail: string;
  actorId: string;
  actorEmail: string;
}): Promise<boolean> {
  const occurredAt = new Date().toISOString();
  try {
    const pb = await getPbAsSuperuser();
    await pb.collection('ClusterEvents').create({
      kind: 'repair',
      source: 'action',
      severity: input.severity,
      category: 'maintenance',
      node_id: input.nodeId,
      node_hostname: '',
      node_zone: '',
      // No node name in the title: the timeline resolves names live from the
      // layout via <NodeIdentity>, and this repo never denormalizes one onto a row.
      title: input.title,
      detail: input.detail,
      // Raw, as this collection requires — the UI formats by `kind`.
      new_value: input.action,
      occurred_at: occurredAt,
      ended_at: occurredAt,
      actor_id: input.actorId,
      actor_email: input.actorEmail,
    });
    return true;
  } catch (err) {
    console.error('[repairs] repair launched but timeline row failed', err);
    return false;
  }
}
