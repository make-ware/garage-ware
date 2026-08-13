import { describe, expect, it } from 'vitest';
import {
  CLUSTER_EVENT_CATEGORIES,
  CLUSTER_EVENT_KINDS,
  CLUSTER_EVENT_SEVERITIES,
} from '@garage-ware/shared';
import {
  CATEGORY_LABELS,
  KIND_LABELS,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  TIMELINE_DAYS,
  eventBadgeLabel,
  groupEventsByWeek,
  startOfWeek,
} from './cluster-timeline';

/** A row shaped like the timeline projection, in PocketBase's date format. */
function ev(when: Date, id: string) {
  return { id, occurred_at: when.toISOString().replace('T', ' ') };
}

function daysFrom(base: Date, delta: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + delta);
  return d;
}

/** Wednesday 10:30 local — mid-week, so the current bucket is a partial one. */
const NOW = new Date(2026, 7, 12, 10, 30);

describe('startOfWeek', () => {
  it('returns local Monday midnight', () => {
    const s = startOfWeek(NOW);
    expect(s.getDay()).toBe(1);
    expect(s.getHours()).toBe(0);
    expect(s.getMinutes()).toBe(0);
    expect(s.getSeconds()).toBe(0);
    expect(s.getMilliseconds()).toBe(0);
  });

  it('treats Sunday as the end of the week, not the start', () => {
    const monday = startOfWeek(NOW);
    const sunday = daysFrom(monday, 6);
    expect(sunday.getDay()).toBe(0);
    expect(startOfWeek(sunday).getTime()).toBe(monday.getTime());
  });

  it('is idempotent', () => {
    const once = startOfWeek(NOW);
    expect(startOfWeek(once).getTime()).toBe(once.getTime());
  });
});

describe('groupEventsByWeek', () => {
  it('emits nothing at all for an empty timeline', () => {
    expect(groupEventsByWeek([], NOW)).toEqual([]);
  });

  it('emits only weeks that have events', () => {
    // Two events three weeks apart: the fortnight between them gets no marker.
    const buckets = groupEventsByWeek(
      [ev(daysFrom(NOW, -1), 'recent'), ev(daysFrom(NOW, -21), 'older')],
      NOW
    );
    expect(buckets).toHaveLength(2);
    expect(buckets.every((b) => b.items.length > 0)).toBe(true);
  });

  it('orders buckets newest first and labels the two most recent', () => {
    const buckets = groupEventsByWeek(
      [
        ev(daysFrom(NOW, -1), 'a'),
        ev(daysFrom(NOW, -8), 'b'),
        ev(daysFrom(NOW, -15), 'c'),
      ],
      NOW
    );
    expect(buckets.map((b) => b.label)).toEqual([
      'This week',
      'Last week',
      expect.stringMatching(/^Week of /),
    ]);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i - 1].weekStart.getTime()).toBeGreaterThan(
        buckets[i].weekStart.getTime()
      );
    }
  });

  it('keeps every bucket on local Monday midnight all year round', () => {
    // Covers whatever DST transitions the runner's timezone has: stepping to
    // the start of a week must never drift onto a Sunday 23:00 or a Monday
    // 01:00, which millisecond arithmetic would.
    for (let week = 0; week < 53; week++) {
      const now = daysFrom(NOW, week * 7);
      const buckets = groupEventsByWeek(
        [ev(daysFrom(now, -1), 'a'), ev(daysFrom(now, -9), 'b')],
        now
      );
      expect(buckets.length).toBeGreaterThan(0);
      for (const bucket of buckets) {
        expect(bucket.weekStart.getDay()).toBe(1);
        expect(bucket.weekStart.getHours()).toBe(0);
      }
    }
  });

  it('puts an event on local Monday midnight in the week it opens', () => {
    const monday = startOfWeek(NOW);
    const [holder] = groupEventsByWeek([ev(monday, 'a')], NOW);
    expect(holder.weekStart.getTime()).toBe(monday.getTime());
    expect(holder.label).toBe('This week');
  });

  it('puts an event one millisecond earlier in the previous week', () => {
    const justBefore = new Date(startOfWeek(NOW).getTime() - 1);
    const [holder] = groupEventsByWeek([ev(justBefore, 'a')], NOW);
    expect(holder.label).toBe('Last week');
  });

  it('preserves the order it was given within a bucket', () => {
    const events = [
      ev(daysFrom(NOW, -1), 'newest'),
      ev(daysFrom(NOW, -2), 'middle'),
      ev(new Date(NOW.getTime() - 2.5 * 86_400_000), 'oldest'),
    ];
    const ids = groupEventsByWeek(events, NOW).flatMap((b) =>
      b.items.map((i) => i.id)
    );
    expect(ids).toEqual(['newest', 'middle', 'oldest']);
  });

  it('drops events older than the window', () => {
    const buckets = groupEventsByWeek(
      [ev(daysFrom(NOW, -(TIMELINE_DAYS + 15)), 'ancient')],
      NOW
    );
    expect(buckets).toEqual([]);
  });

  it('keeps an event from the last day of the window', () => {
    const buckets = groupEventsByWeek(
      [ev(daysFrom(NOW, -(TIMELINE_DAYS - 1)), 'edge')],
      NOW
    );
    expect(buckets.flatMap((b) => b.items.map((i) => i.id))).toEqual(['edge']);
  });

  it('keeps a future note inside one further window', () => {
    // Planned maintenance next week is worth showing, and sorts to the top.
    const buckets = groupEventsByWeek(
      [ev(daysFrom(NOW, TIMELINE_DAYS - 2), 'planned'), ev(NOW, 'now')],
      NOW
    );
    expect(buckets[0].items.map((i) => i.id)).toEqual(['planned']);
  });

  it('drops a note dated absurdly far ahead', () => {
    // A mistyped year in the log dialog's datetime-local field must not park
    // itself permanently at the top of everyone's timeline.
    expect(
      groupEventsByWeek([ev(daysFrom(NOW, 4 * 365), 'typo')], NOW)
    ).toEqual([]);
  });

  it('ignores an unparseable date rather than bucketing it as Invalid', () => {
    expect(groupEventsByWeek([{ occurred_at: 'not a date' }], NOW)).toEqual([]);
  });

  it('honours a shorter window', () => {
    const buckets = groupEventsByWeek(
      [ev(daysFrom(NOW, -3), 'in'), ev(daysFrom(NOW, -20), 'out')],
      NOW,
      7
    );
    expect(buckets.flatMap((b) => b.items.map((i) => i.id))).toEqual(['in']);
  });
});

describe('eventBadgeLabel', () => {
  it('labels a manual row by its category, never "Note"', () => {
    expect(
      eventBadgeLabel({
        kind: 'note',
        source: 'manual',
        category: 'disk-replaced',
      })
    ).toBe('Disk replaced');
  });

  it('falls back to the kind for a detector row, which has no category', () => {
    expect(
      eventBadgeLabel({
        kind: 'disk_changed',
        source: 'detector',
        category: '',
      })
    ).toBe('Disk changed');
  });

  it('falls back to the kind for a manual row with no category', () => {
    expect(eventBadgeLabel({ kind: 'note', source: 'manual' })).toBe('Note');
  });

  it('passes through an unknown category rather than rendering blank', () => {
    expect(
      eventBadgeLabel({ kind: 'note', source: 'manual', category: 'invented' })
    ).toBe('invented');
  });
});

describe('presentation maps', () => {
  it('labels every event kind', () => {
    for (const kind of CLUSTER_EVENT_KINDS) {
      expect(KIND_LABELS[kind]).toBeTruthy();
    }
  });

  it('labels every category', () => {
    for (const category of CLUSTER_EVENT_CATEGORIES) {
      expect(CATEGORY_LABELS[category]).toBeTruthy();
    }
  });

  it('tones and names every severity', () => {
    for (const severity of CLUSTER_EVENT_SEVERITIES) {
      expect(SEVERITY_TONE[severity]).toBeTruthy();
      expect(SEVERITY_LABEL[severity]).toBeTruthy();
    }
  });
});
