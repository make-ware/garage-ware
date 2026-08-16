import 'server-only';
import PocketBase from 'pocketbase';
import type { User } from '@garage-ware/shared';
import { GarageError } from '@/lib/garage/errors';
import type { TypedPocketBase } from '@/lib/types';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// Server-side calls cannot use a relative URL (NEXT_PUBLIC_POCKETBASE_URL is
// often "/" in prod so the browser SDK routes through nginx). Prefer the
// server-only POCKETBASE_URL, fall back to the public var if it's absolute,
// and finally to the in-container default.
function resolvePbUrl(): string {
  const serverUrl = process.env.POCKETBASE_URL;
  if (serverUrl) return serverUrl;
  const publicUrl = process.env.NEXT_PUBLIC_POCKETBASE_URL;
  if (publicUrl && /^https?:\/\//i.test(publicUrl)) return publicUrl;
  return 'http://localhost:8090';
}

const PB_URL = resolvePbUrl();

function readBearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Build a server-side PocketBase client authenticated as the caller.
 * Validates the bearer token by calling authRefresh — invalid tokens throw.
 */
export async function getServerUser(
  req: Request
): Promise<{ pb: TypedPocketBase; user: User & { id: string } }> {
  const token = readBearerToken(req);
  if (!token) {
    throw new HttpError(401, 'Missing bearer token');
  }
  const pb = new PocketBase(PB_URL) as TypedPocketBase;
  pb.autoCancellation(false);
  pb.authStore.save(token, null);
  try {
    const result = await pb.collection('Users').authRefresh();
    const record = result.record as User & { id: string };
    return { pb, user: record };
  } catch {
    throw new HttpError(401, 'Invalid or expired session');
  }
}

/**
 * Check whether a user is an admin. Uses the caller's own auth, so the rule
 * `@collection.Admins.user ?= @request.auth.id` either returns the record
 * (admin) or 404 (not admin).
 */
export async function isUserAdmin(
  pb: TypedPocketBase,
  userId: string
): Promise<boolean> {
  try {
    await pb.collection('Admins').getFirstListItem(`user = "${userId}"`);
    return true;
  } catch {
    return false;
  }
}

export async function requireAdmin(req: Request): Promise<{
  pb: TypedPocketBase;
  user: User & { id: string };
}> {
  const ctx = await getServerUser(req);
  const isAdmin = await isUserAdmin(ctx.pb, ctx.user.id);
  if (!isAdmin) {
    throw new HttpError(403, 'Admin privileges required');
  }
  return ctx;
}

/**
 * Admin-gated, except while the instance has no administrator at all.
 *
 * The setup diagnostics are the one thing an owner needs *before* they can
 * claim the admin seat — telling them "admin privileges required" when the
 * whole problem is that nobody has them yet is the loop this exists to break.
 * Any signed-in caller may read it in that window; once one admin exists, this
 * is exactly `requireAdmin`.
 *
 * Note the window is bounded by a state the owner is actively trying to leave,
 * not by a timer, and reaching it still requires an account on the instance.
 */
export async function requireAdminOrUnclaimed(req: Request): Promise<{
  pb: TypedPocketBase;
  user: User & { id: string };
  isAdmin: boolean;
  claimed: boolean;
}> {
  const ctx = await getServerUser(req);
  const isAdmin = await isUserAdmin(ctx.pb, ctx.user.id);
  if (isAdmin) return { ...ctx, isAdmin: true, claimed: true };

  // Not an admin. Read the admin count as a superuser — the caller's own view
  // of Admins is rule-scoped and 404s for them either way, so it cannot answer
  // "does anyone hold this scope".
  let claimed = true;
  try {
    const su = await getPbAsSuperuser();
    claimed = (await su.collection('Admins').getList(1, 1)).totalItems > 0;
  } catch {
    // If we cannot tell, assume claimed and deny. Failing closed here costs an
    // owner one manual seed-admin run; failing open would expose diagnostics.
    claimed = true;
  }
  if (claimed) {
    throw new HttpError(403, 'Admin privileges required');
  }
  return { ...ctx, isAdmin: false, claimed: false };
}

/**
 * The one superuser client, kept alive between requests.
 *
 * `authWithPassword` runs a bcrypt verification server-side — tens of
 * milliseconds — and several handlers on the dashboard's critical path need
 * privileged reads (transfer labels, invite pickup, the Garage cluster cache,
 * whose collection rules are all null). Minting a fresh client per call paid
 * that cost every time, for a token that stays valid for days.
 *
 * Safe to share: `autoCancellation(false)` means one request cannot abort
 * another's in-flight call, and nothing per-request is stored on the instance —
 * caller identity lives on the separate client `getServerUser` builds.
 */
let superuserPb: TypedPocketBase | null = null;
/** In flight while authenticating, so N parallel misses cost one bcrypt. */
let superuserAuth: Promise<TypedPocketBase> | null = null;

/**
 * Authenticate as a PocketBase superuser using env credentials. Used for
 * trusted admin-only operations that must bypass collection rules.
 */
export async function getPbAsSuperuser(): Promise<TypedPocketBase> {
  if (superuserPb?.authStore.isValid) return superuserPb;
  if (superuserAuth) return superuserAuth;

  const email = process.env.POCKETBASE_ADMIN_EMAIL;
  const password = process.env.POCKETBASE_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new HttpError(
      500,
      'POCKETBASE_ADMIN_EMAIL/PASSWORD not configured for privileged operation'
    );
  }

  superuserAuth = (async () => {
    const pb = new PocketBase(PB_URL);
    pb.autoCancellation(false);
    try {
      await pb.collection('_superusers').authWithPassword(email, password);
    } catch {
      throw new HttpError(500, 'Failed to authenticate PocketBase superuser');
    }
    return pb as unknown as TypedPocketBase;
  })();

  try {
    superuserPb = await superuserAuth;
    return superuserPb;
  } finally {
    // Cleared either way: a failed auth must not be handed to the next caller,
    // and a successful one is served from `superuserPb` from here on.
    superuserAuth = null;
  }
}

/**
 * What HTTP status a Garage failure deserves, and what to tell the caller.
 *
 * Every Garage failure used to fall through to a 500 carrying whatever string
 * the client happened to throw — `fetch failed` for a dead cluster, and the
 * internal "GARAGE_ADMIN_URL and GARAGE_ADMIN_TOKEN must be set..." sentence
 * for an unconfigured one. The five error classes existed but nothing outside
 * `lib/garage/` ever discriminated on them.
 */
function garageErrorResponse(err: GarageError): Response {
  switch (err.code) {
    case 'not_configured':
      return Response.json(
        {
          error:
            'This deployment is not connected to a Garage cluster yet. An administrator needs to set GARAGE_ADMIN_URL and GARAGE_ADMIN_TOKEN.',
          code: err.code,
        },
        { status: 503 }
      );
    case 'unreachable':
    case 'dns':
    case 'tls':
    case 'timeout':
    case 'quorum':
      return Response.json(
        { error: err.message, code: err.code },
        { status: 503 }
      );
    case 'auth':
      return Response.json(
        {
          error:
            'The Garage cluster rejected this deployment’s admin token. An administrator needs to check GARAGE_ADMIN_TOKEN.',
          code: err.code,
        },
        { status: 502 }
      );
    case 'schema':
      return Response.json(
        {
          error:
            'The Garage cluster returned a response this version does not understand. It may be running an incompatible version.',
          code: err.code,
        },
        { status: 502 }
      );
    default:
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.status >= 400 && err.status < 600 ? err.status : 502 }
      );
  }
}

/** A PocketBase SDK error carries the upstream status; keep it. */
function pbErrorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  if ((err as { name?: unknown }).name !== 'ClientResponseError') return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 600
    ? status
    : null;
}

/** Convert a thrown HttpError or GarageError into a Response; 500 otherwise. */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof GarageError) {
    // Not logged as unhandled: an unreachable cluster is an operational state
    // this deployment is expected to survive, not a bug in a handler.
    return garageErrorResponse(err);
  }
  // The PB-proxying routes (node-metrics/scrape, storage-balances/rebuild) call
  // `pb.send`, which throws a ClientResponseError. Flattening that to a 500 is
  // what made the deliberate 503 from the scrape hook — "GARAGE_ADMIN_* not set"
  // — indistinguishable from a crash on the client.
  const proxied = pbErrorStatus(err);
  if (proxied !== null) {
    const message =
      (err as { response?: { message?: unknown } }).response?.message ??
      (err as { message?: unknown }).message;
    return Response.json(
      { error: typeof message === 'string' ? message : 'Upstream error' },
      { status: proxied }
    );
  }
  console.error('[api] unhandled error:', err);
  const message = err instanceof Error ? err.message : 'Internal server error';
  return Response.json({ error: message }, { status: 500 });
}
