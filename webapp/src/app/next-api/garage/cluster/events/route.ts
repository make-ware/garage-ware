import 'server-only';
import { z } from 'zod';
import { ClusterEventMutator } from '@garage-ware/shared/mutators';
import {
  errorResponse,
  getPbAsSuperuser,
  getServerUser,
} from '@/lib/auth/server';
import { TIMELINE_DAYS } from '@/lib/cluster-timeline';
import type {
  ClusterTimelineEvent,
  ClusterTimelineResponse,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * One page is the whole feature. Thirty days of a healthy cluster is a handful
 * of rows; 200 is the ceiling that keeps a pathological week from shipping the
 * entire collection to a browser, and `totalItems` is what lets the card admit
 * it truncated instead of implying it showed everything.
 */
const MAX_ITEMS = 200;

const Query = z.object({
  days: z.coerce.number().int().min(1).max(90).default(TIMELINE_DAYS),
});

/**
 * The cluster timeline, for any signed-in user.
 *
 * This lives under `cluster/` rather than beside `/next-api/garage/events`
 * because that is where the user-facing display family already is —
 * `cluster/nodes` is the one `getServerUser` route there. It also avoids a
 * trap: a sibling of `events/[id]` would be a static segment silently winning
 * over the dynamic one.
 *
 * **The projection is the privacy boundary, not the collection rule.**
 * `ClusterEvents` keeps its admin-only `listRule`, so this reads as a
 * superuser and then rebuilds each row field by field. Spreading the record
 * would work today and leak the next column somebody adds; every field a user
 * sees is named below, and the omissions are documented on
 * `ClusterTimelineEvent`. Adding a field here is a deliberate act — `category`
 * is carried because it is the badge and a closed enum; the free-text columns
 * beside it are not.
 *
 * `getPbAsSuperuser()` is memoized, so this costs no bcrypt on a warm process.
 */
export async function GET(req: Request) {
  try {
    await getServerUser(req);

    const url = new URL(req.url);
    const { days } = Query.parse({
      days: url.searchParams.get('days') ?? undefined,
    });

    // Derived here, never taken as a caller-supplied string: the mutator
    // interpolates both bounds straight into a PocketBase filter.
    //
    // The window is bounded on *both* ends. Forward, because an admin can date
    // a note in the future — planned maintenance next Tuesday — and that is
    // worth showing; but only by one further window, so a note whose year was
    // mistyped can't be fetched and then silently dropped by a grouping that
    // has nowhere to put it. `groupEventsByWeek` clamps to the same bound.
    const now = Date.now();
    const windowStart = new Date(now - days * 86_400_000);
    const windowEnd = new Date(now + days * 86_400_000);

    const pb = await getPbAsSuperuser();
    const result = await new ClusterEventMutator(pb).search(1, MAX_ITEMS, {
      since: windowStart.toISOString(),
      until: windowEnd.toISOString(),
    });

    const items: ClusterTimelineEvent[] = result.items.map((e) => ({
      id: e.id,
      kind: e.kind,
      source: e.source,
      severity: e.severity,
      node_id: e.node_id ?? '',
      category: e.category ?? '',
      title: e.title,
      occurred_at: e.occurred_at,
      ended_at: e.ended_at ?? '',
    }));

    const body: ClusterTimelineResponse = {
      items,
      totalItems: result.totalItems,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      days,
    };
    return Response.json(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
