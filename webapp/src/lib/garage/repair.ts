import 'server-only';
import { GarageClient } from './client';
import { GarageValidationError } from './errors';
import {
  LaunchRepairMultiSchema,
  ListWorkersMultiSchema,
  type RepairType,
  type WorkerInfo,
} from './schemas';
import { outcomeForNode, toNodeOutcomes, type NodeOutcome } from './multi-node';
import type { RepairAction } from '@/lib/repair/operations';

/**
 * Garage's repair and worker endpoints.
 *
 * This is *how to talk to Garage about repairs*. What a repair means to this
 * app — its copy, and how a scrub's status is read out of human prose — lives
 * in `lib/repair/`, which is pure and client-safe. Same split as
 * `lib/cluster-timeline.ts` against `pb_hooks/lib/cluster-events.js`.
 */

/**
 * The allow-list, and the reason `launchRepair` takes a `RepairAction` instead
 * of a `RepairType`.
 *
 * Garage offers ten repair types; this app deliberately exposes three. Keeping
 * the mapping here means the browser names an *action this UI offers* and the
 * server decides what that is on the wire — a client cannot ask for
 * `clearResyncQueue` by editing a request body, because there is no action that
 * maps to it.
 *
 * Typed as a total `Record`, so adding an action without deciding what it sends
 * is a compile error rather than a runtime surprise. That is a stronger
 * guarantee than a test, which is why there isn't one.
 */
const REPAIR_TYPE_FOR_ACTION: Record<RepairAction, RepairType> = {
  'scrub-start': { scrub: 'start' },
  'scrub-pause': { scrub: 'pause' },
  'scrub-resume': { scrub: 'resume' },
  'scrub-cancel': { scrub: 'cancel' },
  blocks: 'blocks',
  rebalance: 'rebalance',
};

/**
 * Every background worker on every node (or on one, with `node`).
 *
 * Deliberately does **not** pass `busyOnly`: an *idle* scrub worker is exactly
 * the one carrying the "last scrub completed at ..." freeform line, which is
 * the only place that timestamp exists.
 */
export async function listWorkers(
  client: GarageClient,
  opts: { node?: string; busyOnly?: boolean; errorOnly?: boolean } = {}
): Promise<NodeOutcome<WorkerInfo[]>[]> {
  const env = await client.request('/v2/ListWorkers', ListWorkersMultiSchema, {
    method: 'POST',
    query: { node: opts.node ?? '*' },
    body: {
      ...(opts.busyOnly !== undefined ? { busyOnly: opts.busyOnly } : {}),
      ...(opts.errorOnly !== undefined ? { errorOnly: opts.errorOnly } : {}),
    },
  });
  return toNodeOutcomes(env);
}

/**
 * Launch one repair on one node.
 *
 * **Rejects `*` and `self`.** `*` would fan the repair out to every node in the
 * cluster while the confirmation dialog named exactly one — the single most
 * damaging mistake available in this feature, and one character away from the
 * correct call. `self` is the node that happens to answer the admin API, which
 * is routinely not the node an admin clicked. The route handler guards both
 * again; two guards on this is not one too many.
 *
 * Returns the outcome for the requested node, or `null` when Garage's envelope
 * mentions it in neither map — see `outcomeForNode`. **`null` is a failure**,
 * and callers must treat it as one.
 */
export async function launchRepair(
  client: GarageClient,
  opts: { nodeId: string; action: RepairAction }
): Promise<NodeOutcome<unknown> | null> {
  const { nodeId, action } = opts;
  if (nodeId === '*' || nodeId === 'self' || nodeId.trim() === '') {
    throw new GarageValidationError('/v2/LaunchRepairOperation', {
      zodIssues: [],
      body: `Refusing to launch a repair against "${nodeId}" — a repair must name one node`,
    });
  }

  const env = await client.request(
    '/v2/LaunchRepairOperation',
    LaunchRepairMultiSchema,
    {
      method: 'POST',
      query: { node: nodeId },
      body: { repairType: REPAIR_TYPE_FOR_ACTION[action] },
    }
  );

  const outcome = outcomeForNode(env, nodeId);
  if (!outcome) {
    // A 200 that named nobody. If a cluster ever keys these maps by a different
    // form of the node id than the one we sent, this is the line that says so —
    // and the fix is one documented change here, not a pre-emptive fuzzy match
    // that would quietly accept the wrong node's answer.
    console.error(
      '[garage/repair] LaunchRepairOperation answered about no known node',
      {
        requested: nodeId,
        successKeys: Object.keys(env.success),
        errorKeys: Object.keys(env.error),
      }
    );
  }
  return outcome;
}
