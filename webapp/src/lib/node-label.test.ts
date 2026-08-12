import { describe, expect, it } from 'vitest';
import {
  buildNodeNameMap,
  nodeLabel,
  parseNodeTags,
  shortNodeId,
} from './node-label';

describe('parseNodeTags', () => {
  it('reads the name out of a name: tag', () => {
    expect(parseNodeTags(['name:vault-01'])).toEqual({
      name: 'vault-01',
      rest: [],
    });
  });

  it('leaves the other tags alone', () => {
    expect(parseNodeTags(['ssd', 'name:vault-01', 'rack4'])).toEqual({
      name: 'vault-01',
      rest: ['ssd', 'rack4'],
    });
  });

  it('has no name when no tag carries one', () => {
    expect(parseNodeTags(['ssd', 'rack4'])).toEqual({
      name: null,
      rest: ['ssd', 'rack4'],
    });
  });

  it('treats no tags at all as no name', () => {
    expect(parseNodeTags([])).toEqual({ name: null, rest: [] });
    expect(parseNodeTags(undefined)).toEqual({ name: null, rest: [] });
    expect(parseNodeTags(null)).toEqual({ name: null, rest: [] });
  });

  it('trims the value, since operators type "name: sofia"', () => {
    expect(parseNodeTags(['name:  sofia  ']).name).toBe('sofia');
  });

  it('matches the prefix case-insensitively but preserves the value case', () => {
    expect(parseNodeTags(['Name:Sofia'])).toEqual({
      name: 'Sofia',
      rest: [],
    });
  });

  it('skips an empty name: tag and keeps scanning', () => {
    // A stray `name:` sorting ahead of the real one must not blank the node.
    expect(parseNodeTags(['name:', 'name:sofia'])).toEqual({
      name: 'sofia',
      rest: ['name:'],
    });
    expect(parseNodeTags(['name:   ']).name).toBeNull();
  });

  it('needs the colon — a bare "name" tag is not a name', () => {
    expect(parseNodeTags(['name'])).toEqual({ name: null, rest: ['name'] });
  });

  it('keeps colons inside the value', () => {
    expect(parseNodeTags(['name:a:b']).name).toBe('a:b');
  });

  it('drops only the tag it consumed, leaving a second name: visible', () => {
    // That the second one is being ignored is worth seeing.
    expect(parseNodeTags(['name:first', 'name:second'])).toEqual({
      name: 'first',
      rest: ['name:second'],
    });
  });
});

describe('shortNodeId', () => {
  it('keeps the first 8 characters and marks the truncation', () => {
    expect(shortNodeId('abcdef0123456789abcdef')).toBe('abcdef01…');
  });

  it('returns a short id whole — an ellipsis must mean something was cut', () => {
    expect(shortNodeId('node-a')).toBe('node-a');
    expect(shortNodeId('abcdefgh')).toBe('abcdefgh');
    expect(shortNodeId('abcdefghi')).toBe('abcdefgh…');
  });
});

describe('nodeLabel', () => {
  it('prefers the name', () => {
    expect(nodeLabel('vault-01', 'abcdef0123456789')).toBe('vault-01');
  });

  it('falls back to the short id', () => {
    expect(nodeLabel(null, 'abcdef0123456789')).toBe('abcdef01…');
    expect(nodeLabel(undefined, 'abcdef0123456789')).toBe('abcdef01…');
  });

  it('leaves two nodes sharing a name distinguishable by their ids', () => {
    // The label alone is ambiguous, which is why admin views pair it with the
    // short id rather than showing the name on its own.
    expect(nodeLabel('sofia', 'aaaaaaaa1111')).toBe('sofia');
    expect(nodeLabel('sofia', 'bbbbbbbb2222')).toBe('sofia');
    expect(shortNodeId('aaaaaaaa1111')).not.toBe(shortNodeId('bbbbbbbb2222'));
  });
});

describe('buildNodeNameMap', () => {
  it('maps only the named nodes', () => {
    const map = buildNodeNameMap([
      { id: 'n1', tags: ['name:alpha'] },
      { id: 'n2', tags: ['ssd'] },
      { id: 'n3' },
    ]);
    expect(map.get('n1')).toBe('alpha');
    expect(map.has('n2')).toBe(false);
    expect(map.has('n3')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('tolerates a missing roles list', () => {
    expect(buildNodeNameMap(undefined).size).toBe(0);
    expect(buildNodeNameMap(null).size).toBe(0);
  });
});
