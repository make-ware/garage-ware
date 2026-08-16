/**
 * Reading a scrub's status out of Garage's worker list.
 *
 * **The problem this module exists for.** The Garage admin API v2.3.0 has no
 * structured last-scrub timestamp anywhere — no `lastScrub`, no
 * `ScrubWorkerState`, no `time_last_complete_scrub`. The single channel is
 * `WorkerInfoResp.freeform: string[]`, which is human prose Garage is free to
 * reword between releases. Worker *names* aren't in the spec either, so even
 * finding the scrub worker is a guess.
 *
 * So this is a parser of English, and it is written to fail safely:
 *
 *  - **`freeform` is returned verbatim and the UI always renders it.** A parse
 *    miss costs precision, never information — whatever Garage said is on
 *    screen regardless of whether we understood it.
 *  - **Keyword-first, timestamp-second, never a whole-line regex.** Each field
 *    is matched independently, so a reworded "last scrub" line cannot also
 *    blank the pause state.
 *  - **Never guess.** An unparseable date yields `null`, never `Invalid Date`.
 *  - **`recognised: false` is its own state.** "Garage said something we don't
 *    understand" is not "this node has never been scrubbed", and rendering the
 *    two identically is exactly the silent all-clear that `role_ok` and the
 *    guards in `metrics/data-coverage.ts` were both written to prevent.
 *
 * Pure: no clock, no I/O, no Goja globals, and — via the structural `WorkerLike`
 * type — no import from `lib/garage/`, the same trick `buildNodeNameMap` uses.
 * That is what lets vitest drive it directly.
 */

/** Structural, so this file never imports the server-only Garage schemas. */
export interface WorkerLike {
  id: number;
  name: string;
  state: WorkerStateLike;
  errors: number;
  consecutiveErrors: number;
  freeform: string[];
  lastError?: { message: string; secsAgo: number } | null;
  persistentErrors?: number | null;
  progress?: string | null;
  queueLength?: number | null;
  tranquility?: number | null;
}

export type WorkerStateLike =
  'busy' | 'idle' | 'done' | { throttled: { durationSecs: number } };

export type FlatWorkerState = 'busy' | 'idle' | 'done' | 'throttled';

/**
 * How the scrub worker is identified, exported so the code, the tests and the
 * UI copy cannot drift apart.
 *
 * Garage names it something like "block scrub worker", but that string is not
 * in the OpenAPI spec — it can only be confirmed against a live cluster, which
 * is why the match is a case-insensitive substring rather than an equality.
 */
export const SCRUB_WORKER_NAME_MATCH = 'scrub';

export interface ScrubStatus {
  workerId: number;
  workerName: string;
  state: FlatWorkerState;
  throttledSecs: number | null;
  progress: string | null;
  /** Set on the node in Garage's own config. Displayed here, never editable. */
  tranquility: number | null;
  errors: number;
  consecutiveErrors: number;
  lastError: { message: string; secsAgo: number } | null;
  /** ISO 8601, parsed from `freeform`. Null when absent or unparseable. */
  lastCompletedAt: string | null;
  /** ISO 8601. When a paused scrub said when it will resume. */
  resumesAt: string | null;
  /**
   * ISO 8601. When Garage intends to run the next automatic scrub.
   *
   * Not something the spec hints at — the live cluster reports it as a second
   * freeform line ("Next scrub scheduled for ..."), which is exactly the sort
   * of thing only a real cluster can tell you.
   */
  nextScheduledAt: string | null;
  corruptionsDetected: number | null;
  paused: boolean;
  /** Always populated, always rendered. */
  freeform: string[];
  /** At least one freeform line matched a pattern we know. Drives the UI hedge. */
  recognised: boolean;
}

/**
 * Flatten the spec's untagged `WorkerStateResp` union into a discriminant plus
 * a number, so nothing downstream writes `typeof state === 'string'`.
 */
export function describeWorkerState(state: WorkerStateLike): {
  state: FlatWorkerState;
  throttledSecs: number | null;
} {
  if (typeof state === 'string') return { state, throttledSecs: null };
  if (state && typeof state === 'object' && 'throttled' in state) {
    const secs = state.throttled?.durationSecs;
    return {
      state: 'throttled',
      throttledSecs: typeof secs === 'number' ? secs : null,
    };
  }
  // Unreachable through the schema, but a Garage that adds a fourth arm should
  // read as "we don't know", not as idle.
  return { state: 'idle', throttledSecs: null };
}

/**
 * The scrub worker among a node's workers, or null.
 *
 * Lowest `id` wins when several match, so the choice is deterministic rather
 * than dependent on Garage's response order.
 */
export function findScrubWorker<T extends { id: number; name: string }>(
  workers: readonly T[]
): T | null {
  const matches = workers.filter((w) =>
    w.name?.toLowerCase().includes(SCRUB_WORKER_NAME_MATCH)
  );
  if (matches.length === 0) return null;
  return matches.reduce((best, w) => (w.id < best.id ? w : best));
}

/**
 * The first timestamp in a line, as ISO 8601, or null.
 *
 * Permissive on shape and strict on validity: it takes anything that looks
 * roughly RFC 3339 and then makes `Date.parse` be the judge, so a matched but
 * nonsensical date (`2026-13-45T99:99:99Z`) comes back null rather than
 * "Invalid Date".
 */
function firstTimestamp(line: string): string | null {
  const m = line.match(
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/
  );
  if (!m) return null;
  const ms = Date.parse(m[0].replace(' ', 'T'));
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** First non-negative integer in a line, or null. */
function firstInteger(line: string): number | null {
  const m = line.match(/\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Everything we can say about a node's scrub, with the raw lines attached.
 *
 * Each `if` below is independent on purpose — Garage rewording one line must
 * not take the others down with it.
 */
export function parseScrubStatus(worker: WorkerLike): ScrubStatus {
  const { state, throttledSecs } = describeWorkerState(worker.state);
  const freeform = worker.freeform ?? [];

  let lastCompletedAt: string | null = null;
  let resumesAt: string | null = null;
  let nextScheduledAt: string | null = null;
  let corruptionsDetected: number | null = null;
  let paused = false;
  let recognised = false;

  for (const raw of freeform) {
    const line = raw.toLowerCase();

    if (line.includes('last scrub') || line.includes('last completed')) {
      recognised = true;
      lastCompletedAt ??= firstTimestamp(raw);
    }
    // Checked before the pause branch would ever see it, and independent of the
    // "last scrub" branch: both lines mention a scrub, and only the leading word
    // separates them.
    if (line.includes('next scrub') || line.includes('scheduled for')) {
      recognised = true;
      nextScheduledAt ??= firstTimestamp(raw);
    }
    if (line.includes('paused') || line.includes('resumes at')) {
      recognised = true;
      paused = true;
      resumesAt ??= firstTimestamp(raw);
    }
    if (line.includes('corruption')) {
      recognised = true;
      corruptionsDetected ??= firstInteger(raw);
    }
  }

  return {
    workerId: worker.id,
    workerName: worker.name,
    state,
    throttledSecs,
    progress: worker.progress ?? null,
    tranquility: worker.tranquility ?? null,
    errors: worker.errors,
    consecutiveErrors: worker.consecutiveErrors,
    lastError: worker.lastError ?? null,
    lastCompletedAt,
    resumesAt,
    nextScheduledAt,
    // `persistentErrors` IS the scrub's corruption count — Garage sets it from
    // `corruptions_detected`, confirmed against a live cluster where nodes
    // report 0, 20, 44 and 1505. It is the single most important number a scrub
    // produces, which is why it is surfaced as its own column rather than left
    // in with the transient worker errors. The freeform branch below is only a
    // fallback for a build that says it in prose instead.
    corruptionsDetected: worker.persistentErrors ?? corruptionsDetected,
    paused,
    freeform,
    recognised,
  };
}
