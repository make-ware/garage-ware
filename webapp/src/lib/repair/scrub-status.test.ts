import { describe, expect, it } from 'vitest';
import {
  SCRUB_WORKER_NAME_MATCH,
  describeWorkerState,
  findScrubWorker,
  parseScrubStatus,
  type WorkerLike,
} from './scrub-status';

function worker(over: Partial<WorkerLike> = {}): WorkerLike {
  return {
    id: 3,
    name: 'block scrub worker',
    state: 'idle',
    errors: 0,
    consecutiveErrors: 0,
    freeform: [],
    ...over,
  };
}

describe('describeWorkerState', () => {
  it('flattens all four arms', () => {
    expect(describeWorkerState('busy')).toEqual({
      state: 'busy',
      throttledSecs: null,
    });
    expect(describeWorkerState('idle').state).toBe('idle');
    expect(describeWorkerState('done').state).toBe('done');
    expect(describeWorkerState({ throttled: { durationSecs: 2.5 } })).toEqual({
      state: 'throttled',
      throttledSecs: 2.5,
    });
  });
});

describe('findScrubWorker', () => {
  it('matches case-insensitively on a substring', () => {
    expect(SCRUB_WORKER_NAME_MATCH).toBe('scrub');
    const found = findScrubWorker([
      { id: 1, name: 'resync worker' },
      { id: 2, name: 'Block Scrub Worker' },
    ]);
    expect(found?.id).toBe(2);
  });

  it('takes the lowest id when several match, so the choice is deterministic', () => {
    const found = findScrubWorker([
      { id: 9, name: 'scrub worker b' },
      { id: 4, name: 'scrub worker a' },
    ]);
    expect(found?.id).toBe(4);
  });

  it('returns null when no worker looks like a scrub worker', () => {
    expect(findScrubWorker([{ id: 1, name: 'resync worker' }])).toBeNull();
    expect(findScrubWorker([])).toBeNull();
  });
});

describe('parseScrubStatus', () => {
  // Verbatim from a live 8-node Garage cluster (v2.x, 2026-08). The OpenAPI
  // spec documents none of this wording, so a real reading is the only proof
  // the parser works — and if a later version rewords it, ADD the new strings
  // as another case rather than replacing these. Supporting both is the point.
  it('parses the wording a live cluster actually emits', () => {
    const s = parseScrubStatus(
      worker({
        name: 'Block scrub worker',
        state: 'idle',
        tranquility: 2,
        persistentErrors: 20,
        freeform: [
          'Last scrub completed at 2026-07-28T08:22:42.548Z',
          'Next scrub scheduled for 2026-08-25T22:50:06.548Z',
        ],
      })
    );
    expect(s.lastCompletedAt).toBe('2026-07-28T08:22:42.548Z');
    expect(s.nextScheduledAt).toBe('2026-08-25T22:50:06.548Z');
    expect(s.corruptionsDetected).toBe(20);
    expect(s.tranquility).toBe(2);
    expect(s.recognised).toBe(true);
    expect(s.paused).toBe(false);
  });

  // Also from the live cluster: a node mid-scrub reports NO freeform at all,
  // only a progress string. That must not read as "never scrubbed" or trip the
  // unrecognised-format hedge — there is simply nothing to recognise yet.
  it('handles a running scrub, which reports progress and no freeform', () => {
    const s = parseScrubStatus(
      worker({
        state: { throttled: { durationSecs: 0.13808042 } },
        progress: '39.52%',
        persistentErrors: 1505,
        freeform: [],
      })
    );
    expect(s.state).toBe('throttled');
    expect(s.progress).toBe('39.52%');
    expect(s.corruptionsDetected).toBe(1505);
    expect(s.lastCompletedAt).toBeNull();
    expect(s.freeform).toEqual([]);
    expect(s.recognised).toBe(false);
  });

  // "Next scrub scheduled for" also contains the word "scrub"; it must not be
  // mistaken for the completion line.
  it('does not read the next-scrub line as a completion date', () => {
    const s = parseScrubStatus(
      worker({
        freeform: ['Next scrub scheduled for 2026-09-11T23:57:17.010Z'],
      })
    );
    expect(s.lastCompletedAt).toBeNull();
    expect(s.nextScheduledAt).toBe('2026-09-11T23:57:17.010Z');
  });

  it("reads Garage's completed-scrub wording into ISO", () => {
    const s = parseScrubStatus(
      worker({
        freeform: [
          'Last scrub completed at 2026-08-09T03:14:00Z, finished in 2 days',
        ],
      })
    );
    expect(s.lastCompletedAt).toBe('2026-08-09T03:14:00.000Z');
    expect(s.recognised).toBe(true);
    expect(s.paused).toBe(false);
  });

  it('reads a paused scrub and when it resumes', () => {
    const s = parseScrubStatus(
      worker({
        state: 'idle',
        progress: '18.00%',
        freeform: ['Paused, resumes at 2026-08-20T01:00:00Z'],
      })
    );
    expect(s.paused).toBe(true);
    expect(s.resumesAt).toBe('2026-08-20T01:00:00.000Z');
    expect(s.progress).toBe('18.00%');
  });

  it('prefers the structured persistentErrors over the prose count', () => {
    const s = parseScrubStatus(
      worker({ persistentErrors: 7, freeform: ['2 corruptions detected'] })
    );
    expect(s.corruptionsDetected).toBe(7);
  });

  it('falls back to a corruption count in prose', () => {
    const s = parseScrubStatus(
      worker({ freeform: ['2 corruptions detected'] })
    );
    expect(s.corruptionsDetected).toBe(2);
  });

  // The whole point of the design: unknown wording loses precision, not information.
  it('keeps freeform verbatim and flags itself unrecognised on unknown wording', () => {
    const lines = ['Bloc-vérification terminée le 9 août', 'etat: repos'];
    const s = parseScrubStatus(worker({ freeform: lines }));
    expect(s.recognised).toBe(false);
    expect(s.lastCompletedAt).toBeNull();
    expect(s.resumesAt).toBeNull();
    expect(s.freeform).toEqual(lines);
  });

  it('never yields Invalid Date when a known line carries no parseable date', () => {
    const s = parseScrubStatus(
      worker({ freeform: ['Last scrub completed at some point recently'] })
    );
    expect(s.recognised).toBe(true);
    expect(s.lastCompletedAt).toBeNull();
  });

  it('rejects a matched but nonsensical date rather than passing it through', () => {
    const s = parseScrubStatus(
      worker({ freeform: ['Last scrub completed at 2026-13-45T99:99:99Z'] })
    );
    expect(s.lastCompletedAt).toBeNull();
  });

  it('carries the typed fields through untouched', () => {
    const s = parseScrubStatus(
      worker({
        state: { throttled: { durationSecs: 1.5 } },
        tranquility: 4,
        errors: 2,
        consecutiveErrors: 1,
        lastError: { message: 'io error', secsAgo: 30 },
      })
    );
    expect(s.state).toBe('throttled');
    expect(s.throttledSecs).toBe(1.5);
    expect(s.tranquility).toBe(4);
    expect(s.errors).toBe(2);
    expect(s.lastError?.message).toBe('io error');
  });

  it('handles a worker with no freeform at all', () => {
    const s = parseScrubStatus(worker({ freeform: [] }));
    expect(s.recognised).toBe(false);
    expect(s.freeform).toEqual([]);
    expect(s.lastCompletedAt).toBeNull();
  });
});
