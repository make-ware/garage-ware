import 'server-only';
import { z } from 'zod';
import { ClusterEventMutator } from '@garage-ware/shared/mutators';
import type { ClusterEvent } from '@garage-ware/shared';
import {
  errorResponse,
  getPbAsSuperuser,
  getServerUser,
} from '@/lib/auth/server';
import { nodeKey } from '@/lib/node-label';
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

/**
 * The projection, in one place so both lists are redacted identically — a
 * second inline copy is how one of them would eventually carry a field the
 * other doesn't.
 */
function toTimelineEvent(e: ClusterEvent): ClusterTimelineEvent {
  return {
    id: e.id,
    kind: e.kind,
    source: e.source,
    severity: e.severity,
    // Keyed on the way out as well as in the row. Rows have carried keys since
    // 1787500000_shorten_node_ids.js; normalising again costs nothing and means
    // this projection cannot leak a full id even if something upstream regresses.
    node_id: e.node_id ? nodeKey(e.node_id) : '',
    category: e.category ?? '',
    title: e.title,
    occurred_at: e.occurred_at,
    ended_at: e.ended_at ?? '',
  };
}

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
    const events = new ClusterEventMutator(pb);
    // `openEvents` is deliberately **not** windowed. A repair that has been
    // open for six weeks is exactly the one worth flagging, and scoping it to
    // the timeline's 30 days would quietly clear the marker on the node that
    // has been broken longest. `listOpenManual` is the collection's own query
    // for this — `(source, ended_at)` is indexed for it.
    const [windowed, open] = await Promise.all([
      events.search(1, MAX_ITEMS, {
        since: windowStart.toISOString(),
        until: windowEnd.toISOString(),
      }),
      events.listOpenManual(),
    ]);

    const body: ClusterTimelineResponse = {
      items: windowed.items.map(toTimelineEvent),
      openEvents: open.items.map(toTimelineEvent),
      totalItems: windowed.totalItems,
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
