import { describe, expect, it } from 'vitest';
import type { ClusterNodeItem } from '@/lib/types';
import {
  NO_ZONE_LABEL,
  groupNodesByZone,
  nodeLabelFor,
} from './cluster-groups';

function item(
  overrides: Partial<ClusterNodeItem> & { id: string }
): ClusterNodeItem {
  return {
    zone: 'z1',
    tags: [],
    capacity: null,
    isUp: true,
    draining: false,
    garageVersion: null,
    lastSeenSecsAgo: null,
    diskFreeBytes: null,
    diskTotalBytes: null,
    metaFreeBytes: null,
    metaTotalBytes: null,
    ...overrides,
  };
}

describe('nodeLabelFor', () => {
  it('prefers the name: tag', () => {
    expect(nodeLabelFor({ tags: ['ssd', 'name:garage-1'], id: 'abcdef' })).toBe(
      'garage-1'
    );
  });

  it('falls back to the node key', () => {
    expect(
      nodeLabelFor({
        tags: [],
        id: 'abcdef0123456789fedcba98765432100123456789abcdeffedcba9876543210',
      })
    ).toBe('abcdef0123456789');
  });
});

describe('groupNodesByZone', () => {
  it('returns no groups for no items', () => {
    expect(groupNodesByZone([])).toEqual([]);
  });

  it('creates one group per zone, alphabetically', () => {
    const groups = groupNodesByZone([
      item({ id: 'n1', zone: 'beta' }),
      item({ id: 'n2', zone: 'alpha' }),
      item({ id: 'n3', zone: 'beta' }),
    ]);
    expect(groups.map((g) => g.zone)).toEqual(['alpha', 'beta']);
    expect(groups.map((g) => g.items.length)).toEqual([1, 2]);
  });

  it('sorts nodes within a zone by label', () => {
    const [group] = groupNodesByZone([
      item({ id: 'n1', zone: 'z', tags: ['name:zulu'] }),
      item({ id: 'n2', zone: 'z', tags: ['name:alpha'] }),
    ]);
    expect(group.items.map((i) => i.id)).toEqual(['n2', 'n1']);
  });

  it('interleaves unnamed nodes among named ones by rendered label', () => {
    // The comparator runs over what is actually shown, so an unnamed node
    // sorts by its short id rather than collecting at one end.
    const [group] = groupNodesByZone([
      item({ id: 'zzzzzzzz1', zone: 'z', tags: ['name:mike'] }),
      item({ id: 'bbbbbbbb1', zone: 'z' }),
      item({ id: 'aaaaaaaa1', zone: 'z', tags: ['name:zulu'] }),
    ]);
    expect(group.items.map((i) => i.id)).toEqual([
      'bbbbbbbb1', // "bbbbbbbb…"
      'zzzzzzzz1', // "mike"
      'aaaaaaaa1', // "zulu"
    ]);
  });

  it('labels the empty zone as "no zone" but keeps the raw key', () => {
    const [group] = groupNodesByZone([item({ id: 'n1', zone: '' })]);
    expect(group.zone).toBe('');
    expect(group.label).toBe(NO_ZONE_LABEL);
  });

  it('sums declared and reported zone capacity, treating null as zero', () => {
    const [group] = groupNodesByZone([
      item({ id: 'n1', zone: 'z', capacity: 100, diskTotalBytes: 90 }),
      item({ id: 'n2', zone: 'z', capacity: null, diskTotalBytes: null }),
      item({ id: 'n3', zone: 'z', capacity: 50, diskTotalBytes: 40 }),
    ]);
    expect(group).toMatchObject({
      capacityBytes: 150,
      reportedBytes: 130,
    });
  });

  it('does not mutate the input array order', () => {
    const items = [
      item({ id: 'n1', zone: 'z', tags: ['name:zulu'] }),
      item({ id: 'n2', zone: 'z', tags: ['name:alpha'] }),
    ];
    groupNodesByZone(items);
    expect(items.map((i) => i.id)).toEqual(['n1', 'n2']);
  });
});
