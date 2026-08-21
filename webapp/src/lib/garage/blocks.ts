import 'server-only';
import { GarageClient } from './client';
import { GarageValidationError } from './errors';
import {
  ListBlockErrorsMultiSchema,
  RetryBlockResyncMultiSchema,
  type BlockError,
} from './schemas';
import { outcomeForNode, toNodeOutcomes, type NodeOutcome } from './multi-node';

/**
 * Garage's `Block`-tagged endpoints: which blocks a node failed to fetch, and
 * asking it to try again.
 *
 * **Why this is not more of `repair.ts`.** That file's whole docblock is about
 * `REPAIR_TYPE_FOR_ACTION` being *the* allow-list — six UI actions mapped onto
 * three of Garage's ten repair types, typed as a total `Record` so adding an
 * action without deciding what it sends is a compile error. Putting a second
 * launch-shaped function beside `launchRepair` invites exactly the merge that
 * guard exists to prevent, and there is no `RepairType` that means "retry block
 * resync" to merge it into: the nearest, `clearResyncQueue`, does the opposite.
 * So retrying lives here, keyed by `BlockOperation` rather than `RepairAction`,
 * and `POST /next-api/garage/repairs` still 400s on `'retry-resync'` — which it
 * should, because it is not a launchable repair.
 *
 * **What this file refuses to wrap.** `PurgeBlocks` is one operation away in
 * the same tag and permanently deletes every object and multipart upload that
 * references a missing block — the most destructive call in the whole admin
 * API, and one an operations console must never make on a click.
 * `GetBlockInfo` is read-only but enumerates the buckets and object versions
 * containing a block, which is user data this admin surface has no reason to
 * read. Neither is wrapped, neither is granted in the README's token scope, and
 * `repairs/block-ops-boundary.test.ts` fails the build if either name appears
 * in non-comment source — the same technique `staging-boundary.test.ts` uses
 * for `ApplyClusterLayout`.
 */

/**
 * Longer than the client's 15s default, for the one call in this app that can
 * legitimately return a very large body. See `listBlockErrors`.
 */
export const LIST_BLOCK_ERRORS_TIMEOUT_MS = 30_000;

/**
 * Every block currently in an errored state, per node.
 *
 * **Unbounded and unpaginated.** `ListBlockErrors` takes no filter, no limit
 * and no cursor — only `node` — so a node whose drive has died can answer with
 * millions of entries, all of which are fetched, JSON-parsed and validated
 * here. There is no API-side mitigation; the route caps what it *renders* and
 * says how much it dropped, and `timeoutMs` is raised for this one call so a
 * large but finite answer arrives rather than aborting halfway.
 *
 * Garage guarantees **no ordering**. Anything the UI shows first is this app's
 * choice, and the route says so on screen.
 */
export async function listBlockErrors(
  client: GarageClient,
  opts: { node?: string } = {}
): Promise<NodeOutcome<BlockError[]>[]> {
  const env = await client.request(
    '/v2/ListBlockErrors',
    ListBlockErrorsMultiSchema,
    {
      query: { node: opts.node ?? '*' },
      timeoutMs: LIST_BLOCK_ERRORS_TIMEOUT_MS,
    }
  );
  return toNodeOutcomes(env);
}

/**
 * Ask one node to re-queue errored blocks for resync.
 *
 * **Refuses `*` and `self`, exactly as `launchRepair` does**, and for a sharper
 * reason than usual: `{all: true}` against `*` re-queues every errored block on
 * every node in the cluster from a dialog that named one. `self` is whichever
 * node answers the admin API, which is routinely not the node an operator
 * clicked.
 *
 * The parameter type is the app's policy: `{all: true}` or a non-empty list of
 * hashes, where the wire schema would accept `{all: false}`. The route narrows
 * further still — it sends only `{all: true}`, because the path is the
 * operation and there is no action enum to smuggle anything into.
 *
 * Returns `null` when the envelope names the node in neither map. **`null` is a
 * failure** and callers must treat it as one — see `outcomeForNode`.
 */
export async function retryBlockResync(
  client: GarageClient,
  opts: {
    nodeId: string;
    request: { all: true } | { blockHashes: string[] };
  }
): Promise<NodeOutcome<{ count: number }> | null> {
  const { nodeId, request } = opts;
  if (nodeId === '*' || nodeId === 'self' || nodeId.trim() === '') {
    throw new GarageValidationError('/v2/RetryBlockResync', {
      zodIssues: [],
      body: `Refusing to retry block resync against "${nodeId}" — it must name one node`,
    });
  }

  const env = await client.request(
    '/v2/RetryBlockResync',
    RetryBlockResyncMultiSchema,
    { method: 'POST', query: { node: nodeId }, body: request }
  );

  const outcome = outcomeForNode(env, nodeId);
  if (!outcome) {
    // A 200 that named nobody, the same third case `launchRepair` logs. The fix
    // is one documented change here, not a fuzzy match that would quietly
    // accept another node's answer.
    console.error(
      '[garage/blocks] RetryBlockResync answered about no known node',
      {
        requested: nodeId,
        successKeys: Object.keys(env.success),
        errorKeys: Object.keys(env.error),
      }
    );
  }
  return outcome;
}
