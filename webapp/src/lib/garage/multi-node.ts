import 'server-only';
import { z } from 'zod';

/**
 * The multi-node response envelope every "on-node" Garage admin endpoint
 * returns, and the one safe way to read it.
 *
 * Twelve v2 operations take a `node` query parameter (a node id, `*` for all,
 * or `self` for whichever node answers) and reply with
 *
 *     { success: { <nodeId>: T }, error: { <nodeId>: "message" } }
 *
 * **HTTP 200 on these endpoints means "the coordinator answered", not "the
 * operation ran".** A perfectly successful-looking response can carry nothing
 * but failures. This module exists because the repo has made exactly that
 * mistake once already, on the other side of the workspace: the metrics scrape
 * in pocketbase/pb_hooks/lib/cluster-events.js reads
 * `(stats && stats.success) || {}` from GetNodeStatistics and discards the
 * error map entirely, so a node that failed to answer is indistinguishable
 * from one that reported nothing. Nothing here should be able to repeat that.
 *
 * The defence is the type. `NodeOutcome` is a discriminated union, so there is
 * no way to reach a value without first narrowing on `ok` — a caller cannot
 * read a partial success as a clean one by forgetting a check, because the
 * check is what produces the value.
 */

/** Both keys are required, exactly as the spec declares them. See `multiResponseSchema`. */
export interface MultiResponse<T> {
  success: Record<string, T>;
  error: Record<string, string>;
}

/**
 * `{ success: Record<string, inner>, error: Record<string, string> }`.
 *
 * **Both keys required, deliberately.** The OpenAPI spec marks them so, and a
 * Garage build that stopped emitting `error` must surface as a
 * `GarageValidationError` rather than as a silent all-clear — `client.ts`
 * gives us that for free the moment the schema insists on the key. Making
 * `error` optional here would convert a wire-level regression into a
 * cluster-wide "everything is fine".
 */
export function multiResponseSchema<T extends z.ZodTypeAny>(inner: T) {
  return z.object({
    success: z.record(z.string(), inner),
    error: z.record(z.string(), z.string()),
  });
}

/**
 * What one node said. A discriminated union so `.value` is unreachable without
 * narrowing — see the module docblock.
 */
export type NodeOutcome<T> =
  | { nodeId: string; ok: true; value: T }
  | { nodeId: string; ok: false; error: string };

/**
 * Flatten an envelope into one outcome per node mentioned in either map.
 *
 * A node id appearing in **both** maps resolves to a failure. The spec does not
 * forbid the overlap, and "it partly worked" is not a success — so error wins.
 */
export function toNodeOutcomes<T>(env: MultiResponse<T>): NodeOutcome<T>[] {
  const outcomes: NodeOutcome<T>[] = [];
  for (const [nodeId, error] of Object.entries(env.error)) {
    outcomes.push({ nodeId, ok: false, error });
  }
  for (const [nodeId, value] of Object.entries(env.success)) {
    if (nodeId in env.error) continue;
    outcomes.push({ nodeId, ok: true, value });
  }
  return outcomes;
}

/**
 * The outcome for one specific node, or `null` when the envelope mentions it in
 * neither map.
 *
 * **`null` is a third case and callers must treat it as failure.** For a
 * single-node request, `{ "success": {}, "error": {} }` is the most dangerous
 * response shape in this whole area: a 200 that means nothing happened at all.
 * Returning `null` rather than folding it into either branch is what forces the
 * caller to say so out loud instead of falling through to the success path.
 */
export function outcomeForNode<T>(
  env: MultiResponse<T>,
  nodeId: string
): NodeOutcome<T> | null {
  if (nodeId in env.error) {
    return { nodeId, ok: false, error: env.error[nodeId] };
  }
  if (nodeId in env.success) {
    return { nodeId, ok: true, value: env.success[nodeId] };
  }
  return null;
}
