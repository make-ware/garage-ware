import 'server-only';
import { z } from 'zod';
import { GarageClient, cluster } from '@/lib/garage';
import type { ClusterLayout, ClusterStatus } from '@/lib/garage';
import type { RoleChangeRequest } from '@/lib/garage/cluster';
import { resolveStagingTarget } from '@/lib/garage/node-resolve';
import { errorResponse, HttpError, requireAdmin } from '@/lib/auth/server';
import { nodeKey, parseNodeTags, type NodeKey } from '@/lib/node-label';
import { formatCapacity } from '@/lib/format';
import { writeTimelineActionRow } from '@/lib/cluster/timeline-write';
import {
  applyCommands,
  stagedFingerprint,
  type StagedRoleChangeLike,
} from '@/lib/cluster/staged-changes';

export const dynamic = 'force-dynamic';

/**
 * The cluster layout staging surface: read what is staged, and stage more.
 *
 * **`UpdateClusterLayout` is the only layout mutation this app will ever
 * make.** `ApplyClusterLayout`, `RevertClusterLayout` and
 * `ClusterLayoutSkipDeadNodes` are not wired here, not behind a flag, and
 * `cluster/staging-boundary.test.ts` fails if their names appear anywhere under
 * `lib/garage/` or `app/next-api/`. Staging cannot move a byte: the worst a
 * compromised or buggy garage-ware can do through this handler is leave junk in
 * the pending area, which an admin clears with one `garage layout revert` at
 * the cost of a version bump. Applying would move real data, for hours, with no
 * undo.
 *
 * **Both verbs read live, never `lib/garage/cached.ts`.** This is an action
 * surface, and the version it renders is the one the conflict check is measured
 * against — a stale layout would make that guard meaningless while looking like
 * it worked.
 *
 * **Keys on the wire in both directions.** The browser names a 16-character
 * node key; the full id is resolved here against the live layout ∪ live status,
 * so a connected-but-unassigned node is addressable without the credential ever
 * reaching a page. Everything served back is key-reduced, including the staged
 * changes — which the admin layout route used to spread through untouched.
 */

/** What both verbs serve. Every node identifier in it is a key. */
interface StagingResponse {
  version: number;
  replicationFactor: number;
  parameters: ClusterLayout['parameters'];
  partitionSize?: number;
  roles: {
    id: NodeKey;
    zone: string;
    capacity: number | null;
    tags: string[];
  }[];
  staged: StagedRoleChangeLike[];
  stagedFingerprint: string;
  /**
   * Boolean only. Someone staged a parameter change from outside this app and
   * `garage layout apply` will commit it too, so it has to be visible — but
   * garage-ware neither stages nor renders parameters, and serving the value
   * would invite a control for it.
   */
  stagedParametersPending: boolean;
  candidates: {
    id: NodeKey;
    name: string | null;
    zone: string | null;
    inLayout: boolean;
    isUp: boolean;
  }[];
  fetchedAt: string;
}

/** POST additionally reports whether the timeline row landed. */
interface StageResponse extends StagingResponse {
  logged: boolean;
}

/**
 * Garage's staged changes, projected field by field.
 *
 * Never a spread: the schema's fallback member strips unknown keys already, and
 * projecting explicitly is what guarantees a future field carrying a second
 * full node id cannot ride out to the browser.
 */
function projectStaged(layout: ClusterLayout): StagedRoleChangeLike[] {
  return (layout.stagedRoleChanges ?? []).map((change) => {
    const id = nodeKey(change.id);
    if ('remove' in change && change.remove === true)
      return { id, remove: true };
    if ('zone' in change) {
      return {
        id,
        zone: change.zone,
        capacity: change.capacity ?? null,
        tags: [...(change.tags ?? [])],
      };
    }
    return { id };
  });
}

function shape(
  layout: ClusterLayout,
  status: ClusterStatus,
  replicationFactor: number
): StagingResponse {
  const staged = projectStaged(layout);
  const inLayout = new Set(layout.roles.map((role) => nodeKey(role.id)));

  // The picker's options: every node with a role, plus every node Garage can
  // see that has none — the "give this new node a role" case, which is the
  // whole reason a staging page beats retyping the planner's output by hand.
  const candidates = [
    ...layout.roles.map((role) => ({
      id: nodeKey(role.id),
      name: parseNodeTags(role.tags).name,
      zone: role.zone,
      inLayout: true,
      isUp:
        status.nodes.find((n) => nodeKey(n.id) === nodeKey(role.id))?.isUp ??
        false,
    })),
    ...status.nodes
      .filter((node) => !inLayout.has(nodeKey(node.id)))
      .map((node) => ({
        id: nodeKey(node.id),
        name: parseNodeTags(node.role?.tags).name,
        zone: node.role?.zone ?? null,
        inLayout: false,
        isUp: node.isUp,
      })),
  ];

  return {
    version: layout.version,
    replicationFactor,
    parameters: layout.parameters,
    partitionSize: layout.partitionSize,
    roles: layout.roles.map((role) => ({
      id: nodeKey(role.id),
      zone: role.zone,
      capacity: role.capacity ?? null,
      tags: [...(role.tags ?? [])],
    })),
    staged,
    stagedFingerprint: stagedFingerprint(staged),
    stagedParametersPending:
      layout.stagedParameters !== null && layout.stagedParameters !== undefined,
    candidates,
    fetchedAt: new Date().toISOString(),
  };
}

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const garage = GarageClient.fromEnv();
    const [layout, status, replicationFactor] = await Promise.all([
      cluster.getLayout(garage),
      cluster.getStatus(garage),
      cluster.getReplicationFactor(garage),
    ]);
    return Response.json(shape(layout, status, replicationFactor));
  } catch (err) {
    return errorResponse(err);
  }
}

const NodeKeyField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{16}$/, 'nodeId must be a 16-character node key');

/**
 * Zone and tag values are Garage's own free-form strings, so the constraint
 * here is on what can be typed rather than on what Garage would accept: no
 * whitespace or commas in a tag (the field is comma-separated, and a tag
 * containing one would split into two on the next page load), a leading
 * alphanumeric on a zone (so a stray `-` cannot read as a CLI flag when the
 * operator copies the change into `garage layout assign`).
 */
const ZoneField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'A zone name must start with a letter or digit and contain only letters, digits, ., - or _'
  );

const TagField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\s,]+$/, 'A tag cannot contain spaces or commas');

const Body = z.object({
  expectedVersion: z.number().int().nonnegative(),
  expectedStagedFingerprint: z.string(),
  changes: z
    .array(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('remove'), nodeId: NodeKeyField }),
        z
          .object({
            action: z.literal('assign'),
            nodeId: NodeKeyField,
            zone: ZoneField,
            gateway: z.boolean(),
            /**
             * **Bytes**, matching `UpdateClusterLayout` exactly — 100 GB is
             * `100000000000`, SI, as Garage documents. `0` is refused by
             * `.positive()` separately from "not a number", because Garage
             * reads an absent capacity as *gateway*: a typed 0 means the
             * operator wanted the gateway switch, which is the wording
             * `draftNodeError` already uses in the planner.
             */
            capacityBytes: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER)
              .nullable(),
            tags: z.array(TagField).max(16).default([]),
          })
          .refine((c) => c.gateway === (c.capacityBytes === null), {
            message: 'A gateway has no capacity; a storage node must have one.',
          }),
      ])
    )
    .min(1)
    .max(32),
});

type StageChange = z.infer<typeof Body>['changes'][number];

/** The compact raw form that goes in `previous_value` / `new_value`. */
function rawRole(role: {
  zone: string;
  capacity?: number | null;
  tags?: readonly string[];
}): string {
  const capacity =
    role.capacity === null || role.capacity === undefined
      ? 'gateway'
      : String(role.capacity);
  return `zone=${role.zone};capacity=${capacity};tags=${(role.tags ?? []).join(',')}`;
}

function describeCapacity(bytes: number | null): string {
  return bytes === null ? 'gateway (no capacity)' : formatCapacity(bytes);
}

export async function POST(req: Request) {
  try {
    const { user } = await requireAdmin(req);
    const body = Body.parse(await req.json());

    const garage = GarageClient.fromEnv();
    const [layout, status, replicationFactor] = await Promise.all([
      cluster.getLayout(garage),
      cluster.getStatus(garage),
      cluster.getReplicationFactor(garage),
    ]);

    // The conflict check, before anything is forwarded. Garage has no version
    // or CAS parameter on UpdateClusterLayout — it merges whatever it is sent
    // into whatever is already staged — so this is the only thing standing
    // between two admins and one silently merged staging area that a single
    // `apply` would commit. Never retried: a retry would stage the change the
    // operator has not seen the current state of.
    if (layout.version !== body.expectedVersion) {
      throw new HttpError(
        409,
        `The cluster layout changed since you loaded this page (it is now version ${layout.version}). Refresh and check what is staged before staging again.`
      );
    }
    const currentFingerprint = stagedFingerprint(projectStaged(layout));
    if (currentFingerprint !== body.expectedStagedFingerprint) {
      throw new HttpError(
        409,
        'Someone else staged a change since you loaded this page. Refresh and check what is staged before staging again.'
      );
    }

    // Layout ∪ status: a node with no role yet is addressable, and a node
    // Garage has never heard of is a 404 that says how to fix it.
    const targets = [
      ...layout.roles.map((role) => ({ id: role.id })),
      ...status.nodes
        .filter(
          (node) =>
            !layout.roles.some((role) => nodeKey(role.id) === nodeKey(node.id))
        )
        .map((node) => ({ id: node.id })),
    ];

    const resolved = body.changes.map((change) => ({
      change,
      fullId: resolveStagingTarget(targets, change.nodeId),
    }));

    const roles: RoleChangeRequest[] = resolved.map(({ change, fullId }) =>
      change.action === 'remove'
        ? { id: fullId, remove: true }
        : {
            id: fullId,
            zone: change.zone,
            // Garage's own gateway encoding, and the reason the form always
            // submits all three fields: the API writes every field it is given
            // and blanks the ones it is not, so a zone-only edit would drop the
            // node's tags — including its `name:` tag.
            capacity: change.gateway ? null : change.capacityBytes,
            tags: change.tags,
          }
    );

    // Garage first, the timeline row second — the same inversion of this
    // repo's "PB first, roll back on failure" rule that POST /repairs makes,
    // for the same reason. A staged change is not mirrored state, the row's
    // content depends on the outcome, and there is nothing to roll back to:
    // reverting is a host command that costs a version bump.
    let staged: ClusterLayout | null = null;
    let thrown: unknown = null;
    try {
      staged = await cluster.updateLayout(garage, roles);
    } catch (err) {
      thrown = err;
    }

    const failure =
      thrown instanceof Error ? thrown.message : thrown ? String(thrown) : null;

    const rolesByKey = new Map(
      layout.roles.map((role) => [nodeKey(role.id), role])
    );
    const nextVersion = (staged ?? layout).version;

    let logged = true;
    for (const { change } of resolved) {
      const before = rolesByKey.get(change.nodeId);
      const written = await writeTimelineActionRow({
        kind: 'layout_staged',
        logLabel: '[staging] layout change staged but',
        nodeId: change.nodeId,
        title: titleFor(change, failure !== null),
        severity: failure === null ? 'info' : 'warning',
        category: 'maintenance',
        previousValue: before ? rawRole(before).slice(0, 255) : '',
        newValue: newValueFor(change).slice(0, 255),
        detail: detailFor(change, before, nextVersion, failure).slice(0, 2000),
        actorId: user.id,
        actorEmail: user.email ?? '',
      });
      if (!written) logged = false;
    }

    // Rethrown after the rows land, so `errorResponse` still maps a GarageError
    // to its own status rather than flattening every cause into one.
    if (thrown) throw thrown;
    if (!staged) throw new HttpError(502, 'Garage returned no layout');

    // `UpdateClusterLayout` answers with a full GetClusterLayoutResponse, so
    // the staged area below is strictly fresher than a follow-up read and
    // costs no extra call. Node status and the replication factor are unmoved
    // by staging, so the reads from before the call still describe them.
    const response: StageResponse = {
      ...shape(staged, status, replicationFactor),
      logged,
    };
    return Response.json(response);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}

function titleFor(change: StageChange, failed: boolean): string {
  if (failed) return 'Layout change refused';
  if (change.action === 'remove') return 'Node removal staged';
  return change.gateway ? 'Gateway role staged' : 'Storage role staged';
}

function newValueFor(change: StageChange): string {
  return change.action === 'remove'
    ? 'remove'
    : rawRole({
        zone: change.zone,
        capacity: change.gateway ? null : change.capacityBytes,
        tags: change.tags,
      });
}

/**
 * The readable before → after, and what to run next. Titles carry no node name
 * — the timeline resolves names live from the layout through `<NodeIdentity>`.
 */
function detailFor(
  change: StageChange,
  before:
    | { zone: string; capacity?: number | null; tags?: readonly string[] }
    | undefined,
  version: number,
  failure: string | null
): string {
  if (failure) return `Garage refused the change: ${failure}`;

  const from = before
    ? `zone ${before.zone}, ${describeCapacity(before.capacity ?? null)}, tags [${(before.tags ?? []).join(', ')}]`
    : 'no role in the layout';

  const to =
    change.action === 'remove'
      ? 'removed from the layout'
      : `zone ${change.zone}, ${describeCapacity(change.gateway ? null : change.capacityBytes)}, tags [${change.tags.join(', ')}]`;

  return `Staged: ${from} → ${to}. Not applied — a human runs ${applyCommands(version)[1]} on a cluster host.`;
}
