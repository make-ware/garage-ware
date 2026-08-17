import 'server-only';
import { z } from 'zod';
import { GarageClient } from './client';
import {
  GarageError,
  GarageNotFoundError,
  GarageValidationError,
} from './errors';
import { tokenMatches } from '@/lib/setup/claim';
import {
  GarageKeyListSchema,
  GarageKeySchema,
  type GarageKey,
  type GarageKeyListItem,
} from './schemas';

export async function listKeys(
  client: GarageClient
): Promise<GarageKeyListItem[]> {
  return client.request('/v2/ListKeys', GarageKeyListSchema);
}

/**
 * A key's identity, permissions and bucket access — never its secret.
 *
 * This used to pass `showSecretKey: 'true'` unconditionally, which is how the
 * live secret reached the browser through `GET /next-api/garage/keys/[id]`.
 * Only {@link verifyKeySecret} asks for it now.
 */
export async function getKeyInfo(
  client: GarageClient,
  accessKeyId: string
): Promise<GarageKey> {
  return client.request('/v2/GetKeyInfo', GarageKeySchema, {
    query: { id: accessKeyId },
  });
}

const CreateKeyResponseSchema = GarageKeySchema.extend({
  secretAccessKey: z.string(),
});

/** The only other schema in the app that may hold a secret. Local on purpose. */
const KeySecretSchema = z.object({
  accessKeyId: z.string(),
  secretAccessKey: z.string().nullish(),
});

/**
 * Does `candidate` match the real secret of `accessKeyId`?
 *
 * The proof behind `POST /next-api/garage/keys/claim`. Garage has no "is this
 * secret correct" endpoint — the whole v2 spec has no verification call, only
 * `showSecretKey` — so the comparison has to happen here, which is exactly why
 * this function returns a **boolean and never the secret**. No caller can hold
 * one, so no caller can leak one.
 *
 * Comparison is `tokenMatches`, the constant-time compare already reasoned
 * through in `lib/setup/claim.ts` (it guards the length mismatch that would
 * otherwise make `timingSafeEqual` throw).
 *
 * **A missing key answers `false`, not an error.** The claim route must not
 * distinguish "no such key" from "wrong secret" — that difference is an
 * access-key-id oracle — and returning the same value for both is how this
 * function makes that easy to get right rather than something the caller has to
 * remember.
 *
 * The `catch` is not incidental either: `client.request` attaches the **raw
 * response body** to a `GarageValidationError` when a payload fails to parse,
 * and this is the one request in the app whose body contains a live secret. It
 * must never propagate.
 */
export async function verifyKeySecret(
  client: GarageClient,
  accessKeyId: string,
  candidate: string
): Promise<boolean> {
  let actual: string | null | undefined;
  try {
    const info = await client.request('/v2/GetKeyInfo', KeySecretSchema, {
      query: { id: accessKeyId, showSecretKey: 'true' },
    });
    actual = info.secretAccessKey;
  } catch (err) {
    if (err instanceof GarageNotFoundError) return false;
    if (err instanceof GarageValidationError) {
      // Re-thrown WITHOUT the original, whose `body` holds the secret. Same
      // status and code, so `errorResponse` still maps it to a 502.
      throw new GarageError('Garage returned an unreadable key payload', {
        status: 0,
        endpoint: '/v2/GetKeyInfo',
        code: 'schema',
      });
    }
    throw err;
  }
  if (!actual) return false;
  return tokenMatches(candidate, actual);
}

export async function createKey(
  client: GarageClient,
  input: { name: string; allowCreateBucket?: boolean }
): Promise<z.infer<typeof CreateKeyResponseSchema>> {
  return client.request('/v2/CreateKey', CreateKeyResponseSchema, {
    method: 'POST',
    body: {
      name: input.name,
      allow: input.allowCreateBucket ? { createBucket: true } : undefined,
    },
  });
}

/**
 * Destroy a key on the cluster. **There is no user-facing door to this.**
 *
 * Its only caller is the create-path rollback in `POST /next-api/garage/keys`,
 * where a PocketBase failure must not leave a Garage key behind — and for a key
 * that orphan is worse than a leak, because the secret is returned only on the
 * success path, so nobody holds it. It cannot even be claimed back through
 * `/keys/claim`; an admin has to import it.
 *
 * Users retire a key by **expiring** it instead (`POST /keys/[id]/expiry`),
 * which is reversible and keeps the record of which buckets it could reach. A
 * hard delete stays with the Garage CLI. Per Garage, deleting a key removes its
 * access from every bucket but leaves the buckets themselves dangling.
 *
 * A 404 is success, and `id` goes in the query string — same reasoning as
 * `deleteBucket`, which carries the long version.
 */
export async function deleteKey(
  client: GarageClient,
  accessKeyId: string
): Promise<void> {
  try {
    await client.request('/v2/DeleteKey', z.unknown(), {
      method: 'POST',
      query: { id: accessKeyId },
    });
  } catch (err) {
    if (err instanceof GarageNotFoundError) return;
    throw err;
  }
}

/**
 * Rename a key, or move its expiration.
 *
 * `id` is a **query** parameter — the spec is explicit, and `UpdateKeyRequestBody`
 * has no `id` property at all. This function used to put it in the body, where
 * `buildUrl` never looks, so the call would have reached Garage with no id. It
 * had no callers, which is why nobody noticed; expiring a key is its first, and
 * a silent no-op there would mean a key that reports itself retired and keeps
 * working.
 *
 * `expiration` is RFC 3339. `neverExpires: true` clears it — note that clears
 * it *entirely* rather than restoring a previous value, which is right for keys
 * this app made (it never sets one) and lossy for an imported key that carried
 * a real future expiry.
 */
export async function updateKey(
  client: GarageClient,
  input: {
    id: string;
    newName?: string;
    expiration?: string | null;
    neverExpires?: boolean;
  }
): Promise<GarageKey> {
  const { id, newName, ...rest } = input;
  return client.request('/v2/UpdateKey', GarageKeySchema, {
    method: 'POST',
    query: { id },
    body: { name: newName, ...rest },
  });
}
