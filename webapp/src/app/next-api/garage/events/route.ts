import 'server-only';
import { z } from 'zod';
import { ClusterEventMutator } from '@garage-ware/shared/mutators';
import {
  CLUSTER_EVENT_CATEGORIES,
  CLUSTER_EVENT_KINDS,
  CLUSTER_EVENT_SEVERITIES,
  CLUSTER_EVENT_SOURCES,
} from '@garage-ware/shared';
import {
  errorResponse,
  getPbAsSuperuser,
  requireAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 200;

const Query = z.object({
  nodeId: z.string().max(128).optional(),
  kind: z.enum(CLUSTER_EVENT_KINDS).optional(),
  source: z.enum(CLUSTER_EVENT_SOURCES).optional(),
  severity: z.enum(CLUSTER_EVENT_SEVERITIES).optional(),
  category: z.enum(CLUSTER_EVENT_CATEGORIES).optional(),
  since: z.string().max(40).optional(),
  until: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PER_PAGE)
    .default(DEFAULT_PER_PAGE),
});

/**
 * Browse the cluster timeline. Admin-only, matching the collection's listRule.
 *
 * Reads run under the caller's own `pb`, so PocketBase's rule is the real gate
 * and `requireAdmin` only makes the 403 clean — the same arrangement as
 * /next-api/garage/claim-audit. Writes below need a superuser, because all
 * three write rules are null.
 */
export async function GET(req: Request) {
  try {
    const { pb } = await requireAdmin(req);
    const url = new URL(req.url);
    const query = Query.parse({
      nodeId: url.searchParams.get('nodeId') ?? undefined,
      kind: url.searchParams.get('kind') ?? undefined,
      source: url.searchParams.get('source') ?? undefined,
      severity: url.searchParams.get('severity') ?? undefined,
      category: url.searchParams.get('category') ?? undefined,
      since: url.searchParams.get('since') ?? undefined,
      until: url.searchParams.get('until') ?? undefined,
      page: url.searchParams.get('page') ?? undefined,
      perPage: url.searchParams.get('perPage') ?? undefined,
    });

    const events = new ClusterEventMutator(pb);
    const result = await events.search(query.page, query.perPage, {
      nodeId: query.nodeId,
      kind: query.kind,
      source: query.source,
      severity: query.severity,
      category: query.category,
      since: query.since,
      until: query.until,
    });

    return Response.json({
      items: result.items,
      page: result.page,
      perPage: result.perPage,
      totalItems: result.totalItems,
      totalPages: result.totalPages,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}

/**
 * The manual half of the timeline: what a human observed, and why.
 *
 * `kind` and `source` are not taken from the body — a hand-written row is
 * always `note`/`manual`, and letting a caller claim otherwise would put
 * fabricated observations in among the detector's. The same goes for
 * `previous_value` / `new_value`, which only mean something when a machine
 * measured both sides.
 *
 * `ended_at` left empty means the note is still open, and an open note pinned
 * to a node is what marks that node "under repair" on /admin/events.
 */
const CreateBody = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().max(2000).optional(),
  nodeId: z.string().max(128).optional(),
  nodeHostname: z.string().max(255).optional(),
  nodeZone: z.string().max(64).optional(),
  severity: z.enum(CLUSTER_EVENT_SEVERITIES).default('info'),
  category: z.enum(CLUSTER_EVENT_CATEGORIES).default('other'),
  /** ISO 8601. Defaults to now, which is what the dialog sends. */
  occurredAt: z.string().min(1).max(40).optional(),
  endedAt: z.string().max(40).optional(),
});

export async function POST(req: Request) {
  try {
    const { user } = await requireAdmin(req);
    const body = CreateBody.parse(await req.json());

    const pb = await getPbAsSuperuser();
    const record = await pb.collection('ClusterEvents').create({
      kind: 'note',
      source: 'manual',
      severity: body.severity,
      category: body.category,
      node_id: body.nodeId ?? '',
      node_hostname: body.nodeHostname ?? '',
      node_zone: body.nodeZone ?? '',
      title: body.title,
      detail: body.detail ?? '',
      occurred_at: body.occurredAt ?? new Date().toISOString(),
      ended_at: body.endedAt ?? '',
      actor_id: user.id,
      actor_email: user.email ?? '',
    });

    return Response.json(record, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
