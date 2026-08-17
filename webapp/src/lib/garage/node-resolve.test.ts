import { describe, expect, it } from 'vitest';
import type { ClusterLayout } from './schemas';
import {
  layoutNodeKeys,
  resolveNodeIdentifier,
  resolveNodeKey,
} from './node-resolve';

/**
 * Resolving a public node key back to the full id Garage insists on.
 *
 * The ambiguity cases matter more than they look: a 64-bit prefix collision
 * cannot happen with real ids, so if one ever does, picking the first match
 * would silently address the wrong machine — and on this route that means
 * launching a repair on it.
 */

const A = '1f104208aab74215c9e3a5f70b1d8c4e2b6079d3af51e8c07d24b93fa6e10852';
const B = '904e16b8b686bd4f11223344556677889900aabbccddeeff0011223344556677';

function layout(roles: { id: string; tags?: string[] }[]): ClusterLayout {
  return {
    version: 7,
    roles: roles.map((r) => ({
      id: r.id,
      zone: 'pdx1',
      capacity: 1000,
      tags: r.tags ?? [],
    })),
  } as ClusterLayout;
}

describe('resolveNodeKey', () => {
  it('returns the full id for a key', () => {
    expect(
      resolveNodeKey(layout([{ id: A }, { id: B }]), '1f104208aab74215')
    ).toBe(A);
  });

  it('accepts a full id too, since nodeKey is idempotent', () => {
    expect(resolveNodeKey(layout([{ id: A }]), A)).toBe(A);
  });

  it('404s for a node that is not in the layout', () => {
    expect(() =>
      resolveNodeKey(layout([{ id: A }]), '904e16b8b686bd4f')
    ).toThrow(/No such node/);
  });

  it('409s rather than guessing when two nodes share a key', () => {
    const collided = layout([
      { id: A },
      { id: A.slice(0, 16) + 'f'.repeat(48) },
    ]);
    expect(() => resolveNodeKey(collided, '1f104208aab74215')).toThrow(
      /ambiguous/
    );
  });
});

describe('resolveNodeIdentifier', () => {
  it('takes a full id', () => {
    expect(resolveNodeIdentifier(layout([{ id: A }, { id: B }]), A)).toBe(A);
  });

  it('takes a key', () => {
    expect(
      resolveNodeIdentifier(layout([{ id: A }, { id: B }]), '904e16b8b686bd4f')
    ).toBe(B);
  });

  it('takes a name from the name: tag, as the CLI does', () => {
    const l = layout([{ id: A, tags: ['ssd', 'name:mars'] }, { id: B }]);
    expect(resolveNodeIdentifier(l, 'mars')).toBe(A);
  });

  it('409s on a name two nodes carry', () => {
    const l = layout([
      { id: A, tags: ['name:mars'] },
      { id: B, tags: ['name:mars'] },
    ]);
    expect(() => resolveNodeIdentifier(l, 'mars')).toThrow(/ambiguous/);
  });

  it('does not accept a hostname — never one of the two identifier forms', () => {
    expect(() =>
      resolveNodeIdentifier(layout([{ id: A }]), 'd7f41e63183e')
    ).toThrow(/No such node/);
  });

  it('refuses an empty identifier', () => {
    expect(() => resolveNodeIdentifier(layout([{ id: A }]), '  ')).toThrow(
      /required/
    );
  });

  it('refuses the wildcards Garage itself would honour', () => {
    // `*` would fan an operation across the cluster and `self` names whichever
    // node answered the admin API. Neither is a node the operator picked.
    const l = layout([{ id: A }]);
    expect(() => resolveNodeIdentifier(l, '*')).toThrow(/No such node/);
    expect(() => resolveNodeIdentifier(l, 'self')).toThrow(/No such node/);
  });
});

describe('layoutNodeKeys', () => {
  it('reports keys, never full ids', () => {
    const keys = layoutNodeKeys(layout([{ id: A }, { id: B }]));
    expect([...keys]).toEqual(['1f104208aab74215', '904e16b8b686bd4f']);
    expect(keys.has(A)).toBe(false);
  });
});
