import 'server-only';
import PocketBase from 'pocketbase';
import type { User } from '@garage-ware/shared';
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
 * Authenticate as a PocketBase superuser using env credentials. Used for
 * trusted admin-only operations that must bypass collection rules.
 */
export async function getPbAsSuperuser(): Promise<TypedPocketBase> {
  const email = process.env.POCKETBASE_ADMIN_EMAIL;
  const password = process.env.POCKETBASE_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new HttpError(
      500,
      'POCKETBASE_ADMIN_EMAIL/PASSWORD not configured for privileged operation'
    );
  }
  const pb = new PocketBase(PB_URL);
  pb.autoCancellation(false);
  try {
    await pb.collection('_superusers').authWithPassword(email, password);
  } catch {
    throw new HttpError(500, 'Failed to authenticate PocketBase superuser');
  }
  return pb as unknown as TypedPocketBase;
}

/** Convert thrown HttpError into a Response; rethrow others. */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error('[api] unhandled error:', err);
  const message = err instanceof Error ? err.message : 'Internal server error';
  return Response.json({ error: message }, { status: 500 });
}
