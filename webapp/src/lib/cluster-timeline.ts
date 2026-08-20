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
  repair: 'Repair',
  node_owner_changed: 'Node ownership',
  layout_staged: 'Layout staged',
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

/**
 * Whether a row describes an instant, something still running, or something
 * that ran and stopped.
 *
 * Derived from `ended_at` alone — there is no status column, and deliberately
 * so. The three states are:
 *
 *   ''                     ongoing   — unresolved
 *   equal to occurred_at   instant   — the eleven point-in-time kinds, and
 *                                      every `action` row
 *   after occurred_at      resolved  — the pair bounds a duration
 *
 * The one place this is decided, so /admin/events, the dashboard timeline and
 * the node cards cannot disagree about what "open" means — the mistake
 * `CATEGORY_LABELS` was already making twice before it moved here.
 */
export type EventStatus = 'instant' | 'ongoing' | 'resolved';

export function eventStatus(event: {
  occurred_at: string;
  ended_at?: string;
}): EventStatus {
  if (!event.ended_at) return 'ongoing';
  // Parsed, not compared as strings. Both timestamps come back from PocketBase
  // as `2026-08-11 09:15:00.000Z` and are written from the same instant, so a
  // string comparison would work today — but a row closed through the API
  // carries a real ISO string with the `T` in it, and that would then sort
  // after every space-separated date on the same day.
  const started = parseEventDate(event.occurred_at).getTime();
  const ended = parseEventDate(event.ended_at).getTime();
  if (Number.isNaN(started) || Number.isNaN(ended)) return 'instant';
  return ended > started ? 'resolved' : 'instant';
}

/** The word for each state. `instant` has none — such a row shows no pill. */
export const STATUS_LABEL: Record<EventStatus, string> = {
  instant: '',
  ongoing: 'In progress',
  resolved: 'Resolved',
};

/**
 * Pill classes per state. Amber for something still running, matching the
 * "under repair" marker on the node cards, which is the same idea; muted for
 * something finished, so a resolved outage recedes rather than competing with
 * the live ones.
 */
export const STATUS_TONE: Record<EventStatus, string> = {
  instant: '',
  ongoing: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium',
  resolved: 'bg-muted text-muted-foreground',
};

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
