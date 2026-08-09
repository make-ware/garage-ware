import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getPbAsSuperuser` is memoized because `authWithPassword` runs a bcrypt
 * verification server-side, and several handlers on the dashboard's critical
 * path need privileged reads — the Garage cluster cache most of all, whose
 * collection rules are all null. Minting a client per call would have made the
 * cache cost more than it saves, so the memoization is load-bearing rather
 * than a tidy-up, and these tests count the auth calls.
 */

const pbMock = vi.hoisted(() => ({
  constructed: 0,
  auths: 0,
  /** Flipped to simulate an expired token. */
  valid: true,
  /** Flipped to make authWithPassword reject. */
  failAuth: false,
}));

vi.mock('pocketbase', () => {
  class FakePocketBase {
    authStore = {
      get isValid() {
        return pbMock.valid;
      },
      save() {},
    };
    constructor() {
      pbMock.constructed += 1;
    }
    autoCancellation() {}
    collection() {
      return {
        authWithPassword: async () => {
          pbMock.auths += 1;
          if (pbMock.failAuth) throw new Error('bad credentials');
          return {};
        },
      };
    }
  }
  return { default: FakePocketBase };
});

/** Fresh module state per test — the memo lives at module scope. */
async function loadServerModule() {
  vi.resetModules();
  return import('@/lib/auth/server');
}

beforeEach(() => {
  pbMock.constructed = 0;
  pbMock.auths = 0;
  pbMock.valid = true;
  pbMock.failAuth = false;
  process.env.POCKETBASE_ADMIN_EMAIL = 'admin@example.com';
  process.env.POCKETBASE_ADMIN_PASSWORD = 'secret';
});

describe('getPbAsSuperuser', () => {
  it('reuses the authenticated client instead of re-running bcrypt', async () => {
    const { getPbAsSuperuser } = await loadServerModule();

    const first = await getPbAsSuperuser();
    const second = await getPbAsSuperuser();

    expect(second).toBe(first);
    expect(pbMock.auths).toBe(1);
    expect(pbMock.constructed).toBe(1);
  });

  it('costs one auth when several requests miss at the same moment', async () => {
    // The case the in-flight promise exists for: a cold dashboard load fans
    // out into handlers that all want the superuser client at once.
    const { getPbAsSuperuser } = await loadServerModule();

    const clients = await Promise.all([
      getPbAsSuperuser(),
      getPbAsSuperuser(),
      getPbAsSuperuser(),
      getPbAsSuperuser(),
    ]);

    expect(new Set(clients).size).toBe(1);
    expect(pbMock.auths).toBe(1);
  });

  it('re-authenticates once the stored token stops being valid', async () => {
    const { getPbAsSuperuser } = await loadServerModule();

    await getPbAsSuperuser();
    pbMock.valid = false;
    await getPbAsSuperuser();

    expect(pbMock.auths).toBe(2);
  });

  it('does not hand a failed auth to the next caller', async () => {
    // A rejected in-flight promise must be cleared, or one bad moment would
    // poison every later call in the process.
    const { getPbAsSuperuser } = await loadServerModule();
    pbMock.failAuth = true;
    await expect(getPbAsSuperuser()).rejects.toThrow(
      /Failed to authenticate PocketBase superuser/
    );

    pbMock.failAuth = false;
    await expect(getPbAsSuperuser()).resolves.toBeTruthy();
    expect(pbMock.auths).toBe(2);
  });

  it('still refuses to run without credentials configured', async () => {
    const { getPbAsSuperuser } = await loadServerModule();
    delete process.env.POCKETBASE_ADMIN_EMAIL;
    delete process.env.POCKETBASE_ADMIN_PASSWORD;

    await expect(getPbAsSuperuser()).rejects.toThrow(
      /POCKETBASE_ADMIN_EMAIL\/PASSWORD not configured/
    );
    expect(pbMock.auths).toBe(0);
  });
});
