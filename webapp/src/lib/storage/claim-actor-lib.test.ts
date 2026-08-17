import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// A Goja CommonJS module from the PocketBase hooks, imported across the
// workspace boundary for the same reason cluster-events-lib.test.ts imports
// `diffObservations`: this decides who a claim mutation is attributed to, and
// it runs somewhere with no test runner. `resolveActor` touches no PocketBase
// globals and makes no requires, so it loads fine here; it carries no types,
// hence the local shapes below.
import {
  resolveActor,
  writeClaimAudit,
} from '../../../../pocketbase/pb_hooks/lib/claim-audit.js';

/** The slice of core.RecordRequestEvent that resolveActor actually reads. */
function event(options: {
  superuser: boolean;
  auth?: { id: string; email: string; isSuperuser: boolean };
  headers?: Record<string, string>;
  headersThrow?: boolean;
}) {
  const auth = options.auth;
  return {
    auth: auth
      ? {
          id: auth.id,
          email: () => auth.email,
          isSuperuser: () => auth.isSuperuser,
        }
      : undefined,
    hasSuperuserAuth: () => options.superuser,
    requestInfo: () => {
      if (options.headersThrow) throw new Error('no request info');
      return { headers: options.headers ?? {} };
    },
  };
}

const SERVICE = { id: 'su1', email: 'pb-admin@example.com', isSuperuser: true };
const HUMAN = { id: 'u1', email: 'ada@example.com', isSuperuser: false };

// Header keys arrive lowercased with "-" replaced by "_" (docs/PB_FILTERS.md).
const OWNER_HEADERS = {
  x_claim_actor_id: 'u7',
  x_claim_actor_email: 'owner@example.com',
  x_claim_source: 'node-owner',
};

describe('resolveActor', () => {
  it('ignores forged headers when the request is not superuser-authenticated', () => {
    // The security case. Headers are trivially set by anything that can make a
    // request, so they must count for nothing without credentials no browser
    // holds. A user impersonating an admin here would poison the audit trail.
    const actor = resolveActor(
      event({ superuser: false, auth: HUMAN, headers: OWNER_HEADERS })
    );
    expect(actor).toEqual({
      id: 'u1',
      email: 'ada@example.com',
      type: 'user',
      source: 'api',
    });
  });

  it('honours headers under superuser auth', () => {
    const actor = resolveActor(
      event({ superuser: true, auth: SERVICE, headers: OWNER_HEADERS })
    );
    expect(actor).toEqual({
      id: 'u7',
      email: 'owner@example.com',
      // A named human, even though the transport was a superuser session.
      type: 'user',
      source: 'node-owner',
    });
  });

  it('falls back to the superuser when it sends no actor headers', () => {
    // The PocketBase admin UI editing a claim by hand.
    const actor = resolveActor(event({ superuser: true, auth: SERVICE }));
    expect(actor).toEqual({
      id: 'su1',
      email: 'pb-admin@example.com',
      type: 'superuser',
      source: 'api',
    });
  });

  it('downgrades an unrecognised source rather than failing the write', () => {
    // `source` is a select field: a value outside the enum would be rejected by
    // PocketBase and roll back the claim change the row was describing.
    const actor = resolveActor(
      event({
        superuser: true,
        auth: SERVICE,
        headers: { ...OWNER_HEADERS, x_claim_source: 'made-up' },
      })
    );
    expect(actor.source).toBe('api');
    expect(actor.id).toBe('u7');
  });

  it('refuses "cascade" from a header', () => {
    // Only the hook that knows a cascade is happening may say so.
    const actor = resolveActor(
      event({
        superuser: true,
        auth: SERVICE,
        headers: { ...OWNER_HEADERS, x_claim_source: 'cascade' },
      })
    );
    expect(actor.source).toBe('api');
  });

  it('ignores an actor email with no actor id', () => {
    const actor = resolveActor(
      event({
        superuser: true,
        auth: SERVICE,
        headers: { x_claim_actor_email: 'ghost@example.com' },
      })
    );
    expect(actor.id).toBe('su1');
    expect(actor.type).toBe('superuser');
  });

  it('records a system write when there is no auth at all', () => {
    const actor = resolveActor(event({ superuser: false }));
    expect(actor).toEqual({ id: '', email: '', type: 'system', source: 'api' });
  });

  it('costs precision, never the write, if headers cannot be read', () => {
    const actor = resolveActor(
      event({ superuser: true, auth: SERVICE, headersThrow: true })
    );
    expect(actor.type).toBe('superuser');
  });
});

/**
 * How `writeClaimAudit` combines the resolved actor with an explicit override.
 *
 * This exists because the two agreed in isolation and disagreed in
 * composition: the StorageClaims hooks passed a hardcoded `source: "api"`
 * alongside the actor, so every node-owner grant resolved correctly and was
 * then recorded as an ordinary admin write. `resolveActor` unit tests could not
 * see it. Only the cascade path may override the actor's own source.
 */
describe('writeClaimAudit source precedence', () => {
  const saved: Record<string, unknown>[] = [];

  const app = {
    findCollectionByNameOrId: () => ({ name: 'StorageClaimAudit' }),
    findRecordById: () => ({ email: () => 'target@example.com' }),
    save: (record: { values: Record<string, unknown> }) => {
      saved.push(record.values);
    },
  };

  const claim = {
    id: 'cl1',
    getString: (field: string) =>
      ({
        user: 'u1',
        node_id: 'n1',
        node_hostname: '',
        node_zone: '',
        note: '',
      })[field] ?? '',
  };

  const OWNER = {
    id: 'u7',
    email: 'owner@example.com',
    type: 'user',
    source: 'node-owner',
  };

  beforeAll(() => {
    // `Record` is a Goja global; the module constructs one directly.
    (globalThis as Record<string, unknown>).Record = class {
      values: Record<string, unknown> = {};
      set(key: string, value: unknown) {
        this.values[key] = value;
      }
    };
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).Record;
  });

  it("carries the actor's own source when the caller names none", () => {
    saved.length = 0;
    writeClaimAudit(app, {
      action: 'create',
      claim,
      previousGb: 0,
      newGb: 5,
      actor: OWNER,
    });
    expect(saved[0].source).toBe('node-owner');
    expect(saved[0].actor_email).toBe('owner@example.com');
  });

  it('lets an explicit source win, for the cascade path', () => {
    saved.length = 0;
    writeClaimAudit(app, {
      action: 'delete',
      claim,
      previousGb: 5,
      newGb: 0,
      actor: OWNER,
      source: 'cascade',
    });
    expect(saved[0].source).toBe('cascade');
  });

  it('records a system write when no actor is supplied', () => {
    saved.length = 0;
    writeClaimAudit(app, { action: 'create', claim, previousGb: 0, newGb: 1 });
    expect(saved[0].actor_type).toBe('system');
    expect(saved[0].actor_id).toBe('');
  });
});

/**
 * The bug the tests above could not see, pinned at its actual site.
 *
 * `writeClaimAudit` lets an explicit `source` override the actor's, which the
 * cascade path needs. The three StorageClaims hooks used to pass
 * `source: "api"` as well — so a node-owner grant was resolved correctly and
 * then overwritten on the way out, and every one of them was audited as an
 * ordinary admin write. Nothing short of an end-to-end write caught it.
 *
 * Reading the hook file is blunt, but it is the only place this invariant can
 * be checked without a live PocketBase: the hooks run in Goja and cannot be
 * imported. If the shape of main.pb.js changes enough to break this, rewrite
 * the assertion rather than deleting it.
 */
describe('main.pb.js source overrides', () => {
  // vitest runs with the webapp workspace as cwd.
  const hooks = readFileSync(
    resolve(process.cwd(), '../pocketbase/pb_hooks/main.pb.js'),
    'utf8'
  );

  it('overrides the resolved source in exactly one place, the cascade hook', () => {
    const overrides = hooks.match(/^\s*source: "[^"]*",$/gm) ?? [];
    expect(overrides.map((s) => s.trim())).toEqual(['source: "cascade",']);
  });

  it('hands every claim hook a resolved actor', () => {
    expect(hooks.match(/actor: resolveActor\(e\)/g)).toHaveLength(4);
  });
});
