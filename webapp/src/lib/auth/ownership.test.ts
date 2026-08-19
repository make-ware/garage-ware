import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TypedPocketBase } from '@/lib/types';
import { assertNodeOwner } from './ownership';

/**
 * `assertNodeOwner` is what stands between a signed-in user and the storage
 * ledger of a node they have nothing to do with, so its failure mode matters
 * more than its success one.
 *
 * The fake PocketBase below reproduces the property the real one has and the
 * helper leans on: the NodeOwners listRule is `user = self || admin`, so a
 * lookup by node id under a non-admin's client returns a row ONLY if that user
 * owns it. Ownership rows for other people are simply invisible, which is why
 * the helper needs no superuser auth.
 */

const NODE = 'a1b2c3d4e5f6';

const fake = {
  /** node_id → owning user id. */
  owners: new Map<string, string>(),
  admins: new Set<string>(),
  /** Whose auth the client is acting under. */
  actingAs: '',
};

function pbFor(userId: string): TypedPocketBase {
  fake.actingAs = userId;
  return {
    collection(name: string) {
      if (name === 'NodeOwners') {
        return {
          getFirstListItem: async (filter: string) => {
            const match = /node_id = "([^"]*)"/.exec(filter);
            const nodeId = match?.[1] ?? '';
            const owner = fake.owners.get(nodeId);
            // The listRule, modelled: a row you neither own nor administer is
            // not "forbidden", it is absent — which PocketBase reports as 404.
            const visible =
              owner && (owner === userId || fake.admins.has(userId));
            if (!visible) {
              throw Object.assign(new Error('not found'), { status: 404 });
            }
            return { id: 'no1', user: owner, node_id: nodeId };
          },
        };
      }
      if (name === 'Admins') {
        return {
          getFirstListItem: async (filter: string) => {
            const match = /user = "([^"]*)"/.exec(filter);
            const id = match?.[1] ?? '';
            if (!fake.admins.has(id)) {
              throw Object.assign(new Error('not found'), { status: 404 });
            }
            return { id: 'ad1', user: id };
          },
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  } as unknown as TypedPocketBase;
}

beforeEach(() => {
  fake.owners.clear();
  fake.admins.clear();
  // The cases below describe the feature as enabled; the flag is read at call
  // time, so a stub per test run is enough. Flag-off has its own describe.
  vi.stubEnv('FEATURE_NODE_CLAIMS', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('assertNodeOwner', () => {
  it('passes the node owner', async () => {
    fake.owners.set(NODE, 'u1');
    await expect(assertNodeOwner(pbFor('u1'), NODE, 'u1')).resolves.toEqual({
      isAdmin: false,
    });
  });

  it('refuses a signed-in user who owns some other node', async () => {
    fake.owners.set(NODE, 'u1');
    fake.owners.set('otherNode', 'u2');
    await expect(assertNodeOwner(pbFor('u2'), NODE, 'u2')).rejects.toThrow(
      /do not own this node/
    );
  });

  it('refuses everyone on an unowned node', async () => {
    // Nobody owns it, so nobody may grant from it. Note this is NOT how the
    // claim route decides a node is free — the UNIQUE index is.
    await expect(assertNodeOwner(pbFor('u1'), NODE, 'u1')).rejects.toThrow(
      /do not own this node/
    );
  });

  it('passes an admin who owns nothing', async () => {
    fake.owners.set(NODE, 'u1');
    fake.admins.add('admin1');
    await expect(
      assertNodeOwner(pbFor('admin1'), NODE, 'admin1')
    ).resolves.toEqual({ isAdmin: true });
  });

  it('short-circuits when the caller is already known to be an admin', async () => {
    // No lookup at all — the caller has already paid for the Admins query.
    await expect(
      assertNodeOwner(pbFor('admin1'), NODE, 'admin1', true)
    ).resolves.toEqual({ isAdmin: true });
  });
});

describe('assertNodeOwner with FEATURE_NODE_CLAIMS off', () => {
  it('refuses a non-admin even when they genuinely own the node', async () => {
    // This one check is what makes every NodeOwners row inert while the
    // feature is dark: the owner-fallback paths in the claims handlers all run
    // through here, so they turn admin-only at once. The row itself is kept.
    vi.stubEnv('FEATURE_NODE_CLAIMS', '');
    fake.owners.set(NODE, 'u1');
    await expect(assertNodeOwner(pbFor('u1'), NODE, 'u1')).rejects.toThrow(
      /disabled on this instance/
    );
  });

  it('still passes an admin — the capability falls back to admins', async () => {
    vi.stubEnv('FEATURE_NODE_CLAIMS', '');
    fake.admins.add('admin1');
    await expect(
      assertNodeOwner(pbFor('admin1'), NODE, 'admin1')
    ).resolves.toEqual({ isAdmin: true });
  });

  it('honours a pre-resolved isAdmin without a lookup', async () => {
    vi.stubEnv('FEATURE_NODE_CLAIMS', '');
    await expect(
      assertNodeOwner(pbFor('admin1'), NODE, 'admin1', true)
    ).resolves.toEqual({ isAdmin: true });
  });
});
