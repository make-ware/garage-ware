import { describe, expect, it } from 'vitest';
import {
  STALE_SCRUB_DAYS,
  describeScrubFreshness,
  isStale,
  relativeDays,
} from './scrub-freshness';
import type { ScrubStatus } from './scrub-status';

/**
 * The clock is a parameter, so there are no fake timers here and no drift
 * between what the test asserts and what the page renders.
 *
 * The load-bearing assertions are the ones that keep four different absences
 * from collapsing into "never scrubbed" — see `scrub-status.ts` on why
 * `recognised: false` is its own state.
 */

const NOW = Date.parse('2026-08-20T12:00:00Z');
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function scrub(over: Partial<ScrubStatus> = {}): ScrubStatus {
  return {
    workerId: 1,
    workerName: 'block scrub worker',
    state: 'idle',
    throttledSecs: null,
    progress: null,
    tranquility: 6,
    errors: 0,
    consecutiveErrors: 0,
    lastError: null,
    lastCompletedAt: null,
    resumesAt: null,
    nextScheduledAt: null,
    corruptionsDetected: 0,
    paused: false,
    freeform: [],
    recognised: true,
    ...over,
  };
}

describe('relativeDays', () => {
  it('reads today, yesterday and whole days', () => {
    expect(relativeDays(day(0), NOW)).toBe('today');
    expect(relativeDays(day(1), NOW)).toBe('yesterday');
    expect(relativeDays(day(3), NOW)).toBe('3 days ago');
  });

  it('reads a future timestamp as today, never a negative age', () => {
    // Clock skew between a Garage node and this server is ordinary; "-2 days
    // ago" would look like a fault in the cluster rather than a few seconds of
    // difference.
    expect(
      relativeDays(new Date(NOW + 2 * 86_400_000).toISOString(), NOW)
    ).toBe('today');
  });

  it('returns an empty string for an unparseable date, never NaN', () => {
    expect(relativeDays('not a date', NOW)).toBe('');
  });
});

describe('describeScrubFreshness', () => {
  it('reports a completed scrub with its age', () => {
    const f = describeScrubFreshness(
      { scrub: scrub({ lastCompletedAt: day(3) }) },
      NOW
    );
    expect(f).toMatchObject({
      kind: 'completed',
      ageDays: 3,
      relative: '3 days ago',
    });
  });

  it('outranks everything with a node error', () => {
    // Silence is a diagnosis, not "never scrubbed" — and not the stale date the
    // node last reported, either.
    const f = describeScrubFreshness(
      { scrub: scrub({ lastCompletedAt: day(3) }), nodeError: 'unreachable' },
      NOW
    );
    expect(f).toEqual({ kind: 'node-error', message: 'unreachable' });
  });

  it('distinguishes no scrub worker from no date', () => {
    expect(describeScrubFreshness({ scrub: null }, NOW).kind).toBe('no-worker');
    expect(describeScrubFreshness({ scrub: scrub() }, NOW).kind).toBe(
      'no-date'
    );
  });

  it.each(['busy', 'throttled'] as const)(
    'reads a %s worker with no completion line as in-progress',
    (state) => {
      // A running scrub reports no completion line at all. Calling that
      // "no date" would read as "this node has never been scrubbed".
      expect(
        describeScrubFreshness({ scrub: scrub({ state }) }, NOW).kind
      ).toBe('in-progress');
    }
  );

  it('reads unrecognised prose as its own state, not as no-date', () => {
    // The load-bearing one: "Garage said something we do not understand" is not
    // "this node has never been scrubbed".
    expect(
      describeScrubFreshness({ scrub: scrub({ recognised: false }) }, NOW).kind
    ).toBe('unrecognised');
  });

  it('falls back to no-date for an unparseable completion time', () => {
    expect(
      describeScrubFreshness(
        { scrub: scrub({ lastCompletedAt: 'sometime last week' }) },
        NOW
      ).kind
    ).toBe('no-date');
  });

  it('never produces a negative age', () => {
    const f = describeScrubFreshness(
      {
        scrub: scrub({ lastCompletedAt: new Date(NOW + 60_000).toISOString() }),
      },
      NOW
    );
    expect(f).toMatchObject({ kind: 'completed', ageDays: 0 });
  });
});

describe('isStale', () => {
  it.each([
    [STALE_SCRUB_DAYS - 1, false],
    [STALE_SCRUB_DAYS, false],
    [STALE_SCRUB_DAYS + 1, true],
  ])('at %i days ago → %s', (days, expected) => {
    const f = describeScrubFreshness(
      { scrub: scrub({ lastCompletedAt: day(days) }) },
      NOW
    );
    expect(isStale(f)).toBe(expected);
  });

  it('never calls an absence stale', () => {
    // Only a completed reading can be overdue. Calling "we do not know" overdue
    // is the silent-verdict mistake in the other direction.
    for (const input of [
      { scrub: null },
      { scrub: scrub() },
      { scrub: scrub({ recognised: false }) },
      { scrub: scrub({ state: 'busy' as const }) },
      { scrub: scrub(), nodeError: 'unreachable' },
    ]) {
      expect(isStale(describeScrubFreshness(input, NOW))).toBe(false);
    }
  });
});
