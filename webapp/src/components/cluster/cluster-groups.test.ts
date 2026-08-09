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
    hostname: null,
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
  it('prefers the hostname', () => {
    expect(nodeLabelFor({ hostname: 'garage-1', id: 'abcdef' })).toBe(
      'garage-1'
    );
  });

  it('falls back to the shortened id', () => {
    expect(nodeLabelFor({ hostname: null, id: 'abcdef0123456789abcdef' })).toBe(
      'abcdef012345…'
    );
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
      item({ id: 'n1', zone: 'z', hostname: 'zulu' }),
      item({ id: 'n2', zone: 'z', hostname: 'alpha' }),
    ]);
    expect(group.items.map((i) => i.id)).toEqual(['n2', 'n1']);
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
      item({ id: 'n1', zone: 'z', hostname: 'zulu' }),
      item({ id: 'n2', zone: 'z', hostname: 'alpha' }),
    ];
    groupNodesByZone(items);
    expect(items.map((i) => i.id)).toEqual(['n1', 'n2']);
  });
});
