import { describe, expect, it } from 'vitest';
import {
  BLOCK_OPERATIONS,
  REPAIR_ACTIONS,
  REPAIR_ACTION_IDS,
  SCRUB_ACTIONS,
} from './operations';

/**
 * The guard for the project's hardest constraint in this area: **the repair
 * allow-list stays at six actions over three repair types.**
 *
 * `REPAIR_TYPE_FOR_ACTION` in `lib/garage/repair.ts` is a total
 * `Record<RepairAction, RepairType>`, so adding an action without deciding what
 * it sends is already a compile error — a stronger guarantee than a test, which
 * is why that file has never had one. What the type cannot say is that
 * `retry-resync` must **not** become a `RepairAction`, because it names no
 * repair type at all: the nearest, `clearResyncQueue`, does the opposite. That
 * is what this file pins.
 */

describe('REPAIR_ACTIONS', () => {
  it('is exactly the six actions this app offers', () => {
    expect([...REPAIR_ACTION_IDS].sort()).toEqual([
      'blocks',
      'rebalance',
      'scrub-cancel',
      'scrub-pause',
      'scrub-resume',
      'scrub-start',
    ]);
  });

  it('does not contain retry-resync', () => {
    // The consequence, stated where someone tempted to add it will read it:
    // `POST /next-api/garage/repairs` parses `z.enum(REPAIR_ACTION_IDS)`, so
    // this is what makes that route 400 on 'retry-resync'. Retrying a resync
    // goes to /repairs/block-errors, whose path is the operation.
    expect(REPAIR_ACTION_IDS).not.toContain('retry-resync');
  });

  it('covers every scrub command', () => {
    for (const action of SCRUB_ACTIONS) {
      expect(REPAIR_ACTION_IDS).toContain(action);
    }
  });
});

describe('BLOCK_OPERATIONS', () => {
  it('shares no key with REPAIR_ACTIONS', () => {
    const repairs = new Set(Object.keys(REPAIR_ACTIONS));
    const overlap = Object.keys(BLOCK_OPERATIONS).filter((k) => repairs.has(k));
    expect(overlap).toEqual([]);
  });

  it('has the same copy shape, without being the same record', () => {
    for (const entry of [
      ...Object.values(REPAIR_ACTIONS),
      ...Object.values(BLOCK_OPERATIONS),
    ]) {
      expect(entry.button.length).toBeGreaterThan(0);
      expect(entry.launched.length).toBeGreaterThan(0);
      expect(entry.failed.length).toBeGreaterThan(0);
    }
  });

  it('carries no node name in the timeline titles', () => {
    // Names resolve at display time via <NodeIdentity>; this repo never
    // denormalizes one onto a row.
    for (const entry of [
      ...Object.values(REPAIR_ACTIONS),
      ...Object.values(BLOCK_OPERATIONS),
    ]) {
      expect(entry.launched).not.toMatch(/\bon\b/);
      expect(entry.failed).not.toMatch(/\bon\b/);
    }
  });
});
