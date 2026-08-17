import { describe, expect, it } from 'vitest';
import {
  NODE_KEY_CHARS,
  buildNodeNameMap,
  isFullNodeId,
  isNodeKey,
  nodeKey,
  nodeLabel,
  parseNodeTags,
} from './node-label';

/** A realistic Garage node id: 64 hex characters. */
const FULL_ID =
  '1f104208aab74215c9e3a5f70b1d8c4e2b6079d3af51e8c07d24b93fa6e10852';
const KEY = '1f104208aab74215';

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

describe('nodeKey', () => {
  it('keeps the first 16 characters, as the Garage CLI prints them', () => {
    expect(NODE_KEY_CHARS).toBe(16);
    expect(nodeKey(FULL_ID)).toBe(KEY);
    expect(nodeKey(FULL_ID)).toHaveLength(16);
  });

  it('adds no ellipsis — the key must be a valid prefix of the id', () => {
    // It is matched back against the layout server-side to recover the full
    // id, which `a1b2c3d4…` could never be.
    expect(nodeKey(FULL_ID)).not.toContain('…');
    expect(FULL_ID.startsWith(nodeKey(FULL_ID))).toBe(true);
  });

  it('is idempotent, so it is safe at any boundary', () => {
    expect(nodeKey(nodeKey(FULL_ID))).toBe(KEY);
  });

  it('lowercases, so a pasted id and a stored key compare equal', () => {
    expect(nodeKey(FULL_ID.toUpperCase())).toBe(KEY);
  });

  it('returns a short id whole — every test fixture in the repo is one', () => {
    expect(nodeKey('node-a')).toBe('node-a');
    expect(nodeKey('n1')).toBe('n1');
  });
});

describe('isFullNodeId / isNodeKey', () => {
  it('accepts a real 64-character id', () => {
    expect(isFullNodeId(FULL_ID)).toBe(true);
  });

  it('REFUSES a node key — the claim route must never take a prefix', () => {
    // The key is public: it is on screen, in every payload and in every URL.
    // Accepting it as proof of node control would hand ownership of any node
    // to anyone who can read a page.
    expect(isFullNodeId(KEY)).toBe(false);
    expect(isFullNodeId(FULL_ID.slice(0, 63))).toBe(false);
    expect(isFullNodeId(FULL_ID + 'a')).toBe(false);
  });

  it('refuses anything that is not lowercase hex', () => {
    expect(isFullNodeId(FULL_ID.toUpperCase())).toBe(false);
    expect(isFullNodeId('*')).toBe(false);
    expect(isFullNodeId('self')).toBe(false);
  });

  it('recognises a key, and rejects the wildcards Garage would accept', () => {
    expect(isNodeKey(KEY)).toBe(true);
    expect(isNodeKey(FULL_ID)).toBe(false);
    expect(isNodeKey('*')).toBe(false);
    expect(isNodeKey('self')).toBe(false);
  });
});

describe('nodeLabel', () => {
  it('prefers the name', () => {
    expect(nodeLabel('vault-01', 'abcdef0123456789')).toBe('vault-01');
  });

  it('falls back to the node key', () => {
    expect(nodeLabel(null, FULL_ID)).toBe(KEY);
    expect(nodeLabel(undefined, FULL_ID)).toBe(KEY);
  });

  it('leaves two nodes sharing a name distinguishable by their keys', () => {
    // The label alone is ambiguous, which is why admin views pair it with the
    // key rather than showing the name on its own.
    const a = 'aaaaaaaa11111111' + '0'.repeat(48);
    const b = 'bbbbbbbb22222222' + '0'.repeat(48);
    expect(nodeLabel('sofia', a)).toBe('sofia');
    expect(nodeLabel('sofia', b)).toBe('sofia');
    expect(nodeKey(a)).not.toBe(nodeKey(b));
  });
});

describe('buildNodeNameMap', () => {
  it('keys by node key, not by the full id the layout carries', () => {
    // The layout comes from Garage with full ids; every row looked up against
    // this map carries a key. If these two disagreed, no historical row would
    // ever resolve a name.
    const map = buildNodeNameMap([{ id: FULL_ID, tags: ['name:vault-01'] }]);
    expect(map.get(KEY)).toBe('vault-01');
    expect(map.has(FULL_ID)).toBe(false);
  });

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
