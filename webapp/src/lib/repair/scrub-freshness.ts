import type { ScrubStatus } from './scrub-status';

/**
 * How long ago a node was last scrubbed, and whether that is too long.
 *
 * **A sibling of `scrub-status.ts`, not part of it.** That module is clockless
 * by design and its docblock says so: it parses English and never compares
 * against a clock, which is what lets vitest drive it with no fake timers and
 * what keeps a rewording of one Garage line from moving a verdict. Comparing a
 * parsed date against *now* is precisely the thing it promises not to do, and
 * "45 days is overdue" is policy rather than parsing. So: two files, one
 * dependency, one direction.
 *
 * This module is pure too — the clock is a **parameter**. Callers pass
 * `Date.parse(fetchedAt) || Date.now()`, computed once in the page and threaded
 * down, so the leaf component reads no clock (which `react-hooks/purity`
 * refuses anyway) and the page says "3 days ago *as of this reading*", which is
 * what a page carrying `fetchedAt` should say.
 */

/**
 * When a scrub becomes stale.
 *
 * **A judgement, not a specification.** Garage runs an automatic scrub "about
 * once a month" — this app's own copy, from the overview page, and not a figure
 * the admin API states anywhere. 45 days is a month and a half: late enough
 * that the automatic pass has plainly not happened, early enough to be worth
 * saying. Rendered in the tooltip beside every verdict so a reader can discount
 * it, and shown amber at most, never red: an overdue scrub is a thing to look
 * into, not a fault.
 */
export const STALE_SCRUB_DAYS = 45;

export type ScrubFreshness =
  | { kind: 'completed'; iso: string; ageDays: number; relative: string }
  /** Busy or throttled with no completion line: running, not never-scrubbed. */
  | { kind: 'in-progress' }
  /** Garage's lines were understood and none carried a date. */
  | { kind: 'no-date' }
  /** `recognised: false` — Garage said something we do not parse. */
  | { kind: 'unrecognised' }
  /** The node answered and reported no scrub worker at all. */
  | { kind: 'no-worker' }
  /** The node did not answer. Silence is a diagnosis, not "never scrubbed". */
  | { kind: 'node-error'; message: string };

/**
 * Whole days between `iso` and `now`, in words.
 *
 * A **future** timestamp reads "today", never "-2 days ago": clock skew between
 * a Garage node and this server is ordinary, and a negative age rendered
 * literally looks like a bug in the cluster rather than a difference of
 * seconds. An unparseable string yields `''`, which callers treat as no date.
 */
export function relativeDays(iso: string, now: number): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  const days = Math.floor((now - parsed) / 86_400_000);
  if (!Number.isFinite(days)) return '';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * The one verdict, from a node's scrub reading.
 *
 * **Precedence is load-bearing** and matches what the scrub page's table has
 * always distinguished, so nothing is lost by moving it here:
 *
 *  1. `node-error` — a node that did not answer says nothing about its scrub.
 *  2. `no-worker` — it answered, and no worker matched `name.includes('scrub')`.
 *  3. a parsed date — the only case that produces a number.
 *  4. `in-progress` — busy or throttled, which is why there is no completion
 *     line, and is emphatically not "never scrubbed".
 *  5. `unrecognised` — Garage said something we do not understand. Its own
 *     state, for the reason `scrub-status.ts` gives at length.
 *  6. `no-date` — understood, and genuinely carrying no date.
 */
export function describeScrubFreshness(
  input: { scrub: ScrubStatus | null; nodeError?: string | null },
  now: number
): ScrubFreshness {
  if (input.nodeError) return { kind: 'node-error', message: input.nodeError };
  const scrub = input.scrub;
  if (!scrub) return { kind: 'no-worker' };

  if (scrub.lastCompletedAt) {
    const parsed = Date.parse(scrub.lastCompletedAt);
    if (!Number.isNaN(parsed)) {
      return {
        kind: 'completed',
        iso: scrub.lastCompletedAt,
        // Floored and clamped at zero for the same clock-skew reason
        // `relativeDays` reads a future date as "today".
        ageDays: Math.max(0, Math.floor((now - parsed) / 86_400_000)),
        relative: relativeDays(scrub.lastCompletedAt, now),
      };
    }
    // Parsed by scrub-status and still unreadable here: no date, never NaN.
    return { kind: 'no-date' };
  }

  if (scrub.state === 'busy' || scrub.state === 'throttled') {
    return { kind: 'in-progress' };
  }
  if (!scrub.recognised) return { kind: 'unrecognised' };
  return { kind: 'no-date' };
}

/**
 * Whether this node is overdue. **Only a completed reading can be stale** —
 * everything else is an absence of information, and calling an absence
 * "overdue" is the silent-verdict mistake in the other direction.
 */
export function isStale(freshness: ScrubFreshness): boolean {
  return freshness.kind === 'completed' && freshness.ageDays > STALE_SCRUB_DAYS;
}
