import { describe, expect, it } from 'vitest';
import {
  applyCommands,
  describeStagedChanges,
  nextApplyVersion,
  stagedFingerprint,
} from './staged-changes';

const KEY_A = 'aaaa000000000001';
const KEY_B = 'bbbb000000000002';
const FULL_A = KEY_A + '0123456789abcdef'.repeat(3);

const TB = 1_000_000_000_000;

const ROLES = [
  { id: KEY_A, zone: 'dc1', capacity: 16 * TB, tags: ['ssd', 'name:vault-01'] },
  { id: KEY_B, zone: 'dc2', capacity: null, tags: [] },
];

describe('describeStagedChanges', () => {
  it('joins an assign against the role it replaces', () => {
    const [row] = describeStagedChanges(ROLES, [
      { id: KEY_A, zone: 'dc3', capacity: 32 * TB, tags: ['ssd'] },
    ]);

    expect(row).toMatchObject({
      nodeKey: KEY_A,
      name: 'vault-01',
      kind: 'assign',
      isNew: false,
      fromZone: 'dc1',
      toZone: 'dc3',
      fromCapacityBytes: 16 * TB,
      toCapacityBytes: 32 * TB,
    });
    // The `name:` tag is not stripped from the raw tag lists — the table shows
    // what would actually be written, and this change drops the node's name.
    expect(row.fromTags).toEqual(['ssd', 'name:vault-01']);
    expect(row.toTags).toEqual(['ssd']);
  });

  it('marks a node that has no role yet', () => {
    const [row] = describeStagedChanges(ROLES, [
      { id: 'cccc000000000003', zone: 'dc1', capacity: 4 * TB, tags: [] },
    ]);

    expect(row.isNew).toBe(true);
    expect(row.fromZone).toBeNull();
    expect(row.fromCapacityBytes).toBeNull();
    expect(row.name).toBeNull();
  });

  it('reads a null capacity as a gateway, not as unknown', () => {
    const [row] = describeStagedChanges(ROLES, [
      { id: KEY_A, zone: 'dc1', capacity: null, tags: [] },
    ]);

    expect(row.kind).toBe('assign');
    expect(row.toCapacityBytes).toBeNull();
  });

  it('describes a removal', () => {
    const [row] = describeStagedChanges(ROLES, [{ id: KEY_B, remove: true }]);

    expect(row).toMatchObject({
      kind: 'remove',
      fromZone: 'dc2',
      toZone: null,
    });
  });

  it('surfaces a shape it cannot read rather than dropping it', () => {
    // `garage layout apply` commits this change too. Reporting an empty
    // staging area to an operator about to apply one is the failure mode this
    // state exists to prevent.
    const [row] = describeStagedChanges(ROLES, [{ id: KEY_A }]);

    expect(row.kind).toBe('unrecognised');
    expect(row.nodeKey).toBe(KEY_A);
  });

  it('matches a full id against a keyed role', () => {
    const [row] = describeStagedChanges(ROLES, [
      { id: FULL_A, zone: 'dc1', capacity: TB, tags: [] },
    ]);

    expect(row.nodeKey).toBe(KEY_A);
    expect(row.isNew).toBe(false);
  });
});

describe('stagedFingerprint', () => {
  it('is independent of the order Garage lists changes in', () => {
    const a = { id: KEY_A, zone: 'dc1', capacity: TB, tags: ['ssd'] };
    const b = { id: KEY_B, remove: true };

    expect(stagedFingerprint([a, b])).toBe(stagedFingerprint([b, a]));
  });

  it('is independent of tag order, and of key versus full id', () => {
    expect(
      stagedFingerprint([
        { id: FULL_A, zone: 'dc1', capacity: TB, tags: ['b', 'a'] },
      ])
    ).toBe(
      stagedFingerprint([
        { id: KEY_A, zone: 'dc1', capacity: TB, tags: ['a', 'b'] },
      ])
    );
  });

  it('changes when any part of a change changes', () => {
    const base = [{ id: KEY_A, zone: 'dc1', capacity: TB, tags: ['ssd'] }];
    const fingerprint = stagedFingerprint(base);

    expect(
      stagedFingerprint([
        { id: KEY_A, zone: 'dc2', capacity: TB, tags: ['ssd'] },
      ])
    ).not.toBe(fingerprint);
    expect(
      stagedFingerprint([
        { id: KEY_A, zone: 'dc1', capacity: 2 * TB, tags: ['ssd'] },
      ])
    ).not.toBe(fingerprint);
    expect(
      stagedFingerprint([{ id: KEY_A, zone: 'dc1', capacity: TB, tags: [] }])
    ).not.toBe(fingerprint);
    expect(stagedFingerprint([{ id: KEY_A, remove: true }])).not.toBe(
      fingerprint
    );
  });

  it('distinguishes a gateway from a zero capacity', () => {
    expect(
      stagedFingerprint([{ id: KEY_A, zone: 'dc1', capacity: null, tags: [] }])
    ).not.toBe(
      stagedFingerprint([{ id: KEY_A, zone: 'dc1', capacity: 0, tags: [] }])
    );
  });

  it('is empty for an empty staging area', () => {
    expect(stagedFingerprint([])).toBe('');
  });
});

describe('applyCommands', () => {
  it('names the version apply will produce, not the current one', () => {
    expect(nextApplyVersion(12)).toBe(13);
    expect(applyCommands(12)).toEqual([
      'garage layout show',
      'garage layout apply --version 13',
    ]);
  });

  it('never offers revert', () => {
    // The escape hatch is named in prose, outside anything copyable: it is not
    // an undo, it clears staging by incrementing the layout version.
    expect(applyCommands(3).join('\n')).not.toContain('revert');
  });
});
