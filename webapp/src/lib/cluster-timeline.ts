import type {
  ClusterEventCategory,
  ClusterEventKind,
  ClusterEventSource,
} from '@garage-ware/shared';

/**
 * The cluster timeline: how long a window it covers, what its rows are called,
 * and how they fall into weeks.
 *
 * Deliberately **not** `server-only`, for the same reason as `node-label.ts`,
 * `ledger-math.ts` and `object-cap.ts`: /admin/events and the timeline on
 * /dashboard/cluster both label kinds and colour severities, and a second
 * hand-rolled copy in a component is exactly how node labelling came to
 * render three different ways on three different pages.
 *
 * Named `cluster-timeline` rather than `cluster-events` to stay distinct from
 * pocketbase/pb_hooks/lib/cluster-events.js, which is the *detector* and runs
 * in Goja on the other side of the workspace.
 */

/**
 * How far back the user-facing timeline looks. One constant, read by the
 * fetch, the card's copy and the tests, so none of the three can drift.
 */
export const TIMELINE_DAYS = 30;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Human copy for each kind, used by the admin filter and the row badge. */
export const KIND_LABELS: Record<ClusterEventKind, string> = {
  layout_version: 'Layout version',
  node_added: 'Node added',
  node_removed: 'Node removed',
  capacity_changed: 'Capacity changed',
  zone_changed: 'Zone changed',
  tags_changed: 'Tags changed',
  disk_changed: 'Disk changed',
  data_drop: 'Data drop',
  node_state: 'Node state',
  version_changed: 'Version changed',
  note: 'Note',
};

/**
 * Severity as a background class — the admin page's 1px rail, the dashboard
 * timeline's dot. Both take it from here so the two never disagree about what
 * `warning` looks like.
 */
export const SEVERITY_TONE: Record<string, string> = {
  info: 'bg-muted-foreground/40',
  warning: 'bg-amber-500',
  critical: 'bg-destructive',
};

/**
 * The same three, in words. Colour is never the only carrier of severity, so
 * every dot ships this to a screen reader.
 */
export const SEVERITY_LABEL: Record<string, string> = {
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
};

/**
 * Why a human logged something. The single definition — /admin/events, the log
 * dialog and the dashboard timeline all read it from here, rather than the two
 * hand-kept copies that used to sit in the first two and were commented "the
 * same words either side".
 */
export const CATEGORY_LABELS: Record<ClusterEventCategory, string> = {
  'hardware-failure': 'Hardware failure',
  'disk-replaced': 'Disk replaced',
  maintenance: 'Maintenance',
  upgrade: 'Upgrade',
  incident: 'Incident',
  decommission: 'Decommission',
  other: 'Other',
};

/**
 * The one word that says what sort of thing a row is.
 *
 * For a manual row that is its **category** — every hand-written row has
 * `kind: 'note'`, so labelling it "Note" spends a badge to say nothing, and
 * pairing it with a "by hand" badge said the same nothing twice. "Disk
 * replaced" or "Maintenance" is the word a reader actually wants, and it
 * already implies a human wrote it.
 *
 * A detector row has no category — guessing a cause is the detector's job
 * least of all — so it falls back to its kind.
 */
export function eventBadgeLabel(event: {
  kind: ClusterEventKind;
  source: ClusterEventSource;
  category?: string;
}): string {
  if (event.source === 'manual' && event.category) {
    return (
      CATEGORY_LABELS[event.category as ClusterEventCategory] ?? event.category
    );
  }
  return KIND_LABELS[event.kind] ?? event.kind;
}

export interface WeekBucket<T> {
  /** Local Monday 00:00. Also the bucket's identity. */
  weekStart: Date;
  label: string;
  items: T[];
}

/**
 * PocketBase hands back `2026-08-11 09:15:00.000Z`; `Date` wants the `T`.
 * Same normalisation as `formatPbDateTime`.
 */
function parseEventDate(value: string): Date {
  return new Date(value.replace(' ', 'T'));
}

/**
 * Local Monday 00:00 of the week containing `d`.
 *
 * Local rather than UTC, matching `dayKey()` on /admin/events: a reader groups
 * events by their own calendar, not by the server's. Stepping with
 * `setDate`/`setHours` rather than millisecond arithmetic is what keeps a week
 * spanning a DST change exactly seven local days long.
 */
export function startOfWeek(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  // getDay() is 0=Sun..6=Sat; on a Monday-start week Sunday belongs to the
  // week before, so it steps back six days rather than none.
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
}

function weekLabel(weekStart: Date, currentWeek: Date): string {
  // Round, because a week containing a DST change is 7 days ± 1 hour.
  const weeksBack = Math.round(
    (currentWeek.getTime() - weekStart.getTime()) / WEEK_MS
  );
  if (weeksBack === 0) return 'This week';
  if (weeksBack === 1) return 'Last week';
  return `Week of ${weekStart.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })}`;
}

/**
 * Fold events into one bucket per calendar week, newest week first.
 *
 * **Only weeks that have something in them get a bucket.** An earlier cut drew
 * a marker for every week in the window so quiet stretches were explicit, but
 * on a real cluster most weeks are quiet and the result was a column of "No
 * events" with the occasional event in it — the scaffold drowning the thing it
 * was meant to frame. The window is stated in the card's description instead,
 * which is where a reader looks to find out what they are looking at.
 *
 * Item order within a bucket is preserved, so the server's `-occurred_at` sort
 * carries through untouched.
 *
 * Events outside the window on either side are dropped. Forward as well as
 * back, because an admin can date a note ahead — planned maintenance next
 * Tuesday — and that is worth showing, but only within one further window, so
 * a note whose year was mistyped in the datetime-local field doesn't park
 * itself permanently at the top. The route queries with the same two bounds,
 * so in practice nothing is fetched only to be discarded here.
 */
export function groupEventsByWeek<T extends { occurred_at: string }>(
  events: readonly T[],
  now: Date,
  days: number = TIMELINE_DAYS
): WeekBucket<T>[] {
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - days);
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + days);
  const currentWeek = startOfWeek(now);

  const byWeek = new Map<number, WeekBucket<T>>();
  for (const item of events) {
    const at = parseEventDate(item.occurred_at);
    if (Number.isNaN(at.getTime())) continue;
    if (at < windowStart || at > windowEnd) continue;

    const weekStart = startOfWeek(at);
    const key = weekStart.getTime();
    let bucket = byWeek.get(key);
    if (!bucket) {
      bucket = {
        weekStart,
        label: weekLabel(weekStart, currentWeek),
        items: [],
      };
      byWeek.set(key, bucket);
    }
    bucket.items.push(item);
  }

  return [...byWeek.values()].sort(
    (a, b) => b.weekStart.getTime() - a.weekStart.getTime()
  );
}
