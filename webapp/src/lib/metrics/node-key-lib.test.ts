import { describe, expect, it } from 'vitest';
// The node key exists twice: once in TypeScript for the app, once in CommonJS
// for the PocketBase hooks, because Goja cannot import TypeScript. Imported
// across the workspace boundary for the same reason as signup-gate.js — the
// hook copy decides what gets *written* to every node-bearing collection, and
// it runs somewhere with no test runner. Its top level touches no Goja globals
// and makes no requires.
import {
  NODE_KEY_CHARS as HOOK_CHARS,
  nodeKey as hookNodeKey,
} from '../../../../pocketbase/pb_hooks/lib/node-key.js';
import { NODE_KEY_CHARS, nodeKey } from '@/lib/node-label';

/**
 * If these two ever disagree, the scrape writes rows under one identifier while
 * the app looks them up under another: the cluster map goes blank, every chart
 * loses its series, and the event differ reports every node as new. So they are
 * asserted equal rather than assumed so.
 */
const SAMPLES = [
  '1f104208aab74215c9e3a5f70b1d8c4e2b6079d3af51e8c07d24b93fa6e10852',
  '904E16B8B686BD4F11223344556677889900AABBCCDDEEFF0011223344556677',
  '1f104208aab74215',
  'node-a',
  'n1',
  '',
];

describe('node key parity across the workspace boundary', () => {
  it('agrees on the length', () => {
    expect(HOOK_CHARS).toBe(NODE_KEY_CHARS);
    expect(HOOK_CHARS).toBe(16);
  });

  it('agrees on every shape a node id arrives in', () => {
    for (const sample of SAMPLES) {
      expect(hookNodeKey(sample)).toBe(nodeKey(sample));
    }
  });

  it('agrees that the operation is idempotent', () => {
    for (const sample of SAMPLES) {
      expect(hookNodeKey(hookNodeKey(sample))).toBe(hookNodeKey(sample));
    }
  });

  it('tolerates the null-ish inputs a Goja row read can produce', () => {
    // `record.getString()` on an absent column yields '', and a malformed row
    // could yield undefined. Neither may throw inside the scrape.
    expect(hookNodeKey(undefined)).toBe('');
    expect(hookNodeKey(null)).toBe('');
  });
});
