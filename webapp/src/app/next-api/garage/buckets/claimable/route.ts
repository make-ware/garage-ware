import { AccessKeyMutator } from '@garage-ware/shared/mutators';
import { GarageClient, buckets, keys } from '@/lib/garage';
import { liveKeyIdsFor } from '@/lib/storage/live-keys';
import {
  errorResponse,
  getPbAsSuperuser,
  getServerUser,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

/**
 * Buckets the caller could claim right now — the discoverable half of
 * `POST /buckets/claim`.
 *
 * Without this the flow would be "type a bucket id you are expected to already
 * know", which is the shape `/dashboard/nodes` has to use because a node id is
 * itself the credential. Here it is not: the proof is a key the caller has
 * already claimed, and Garage can be asked which buckets that key owns. So the
 * honest UI is a list, and claiming your key is what populates it.
 *
 * **It discloses nothing new.** Every bucket listed is one the caller's own
 * access key holds `owner` on — they could read the same list from Garage with
 * their own credentials. Nothing here reaches a bucket they do not already
 * control, which is why it is safe on a `getServerUser` gate.
 *
 * Buckets already carrying a PocketBase row are filtered out rather than
 * flagged: a claimed bucket is not claimable, and listing it alongside the free
 * ones would invite a click that can only 409. The caller's own buckets already
 * appear on the same page under "Your buckets".
 *
 * Degrades rather than fails. A key Garage cannot answer for is skipped with a
 * log line — this is an onboarding aid on a working page, and one bad key
 * should not blank the list.
 *
 * ## The cheap question is asked first
 *
 * `/dashboard/buckets` fires this on every load and every refresh, and the
 * answer is empty for almost everybody almost always — onboarding happens once.
 * So the expensive work is gated on the one question that is cheap, shared and
 * conclusive: **are there any unclaimed buckets in the cluster at all?** One
 * `ListBuckets` and one PocketBase read settle it, and on a deployment where
 * everything has been claimed the per-key fan-out below never runs.
 *
 * Order matters and is the whole optimisation. Asking "which buckets does each
 * of this caller's keys own" first costs one `GetKeyInfo` per key on every page
 * load, and then throws the answer away. Asking "is there anything to find"
 * first costs the same two calls whatever the caller holds.
 */

export interface ClaimableBucket {
  id: string;
  /** Global alias, or the raw id when a bucket has none. */
  name: string;
  bytes: number | null;
  objects: number | null;
  /** Garage's `maxSize`, so the UI can say what the claim would reserve. */
  maxSize: number | null;
  /** The caller's key that proves ownership — shown so they know why. */
  viaKeyId: string;
}

export async function GET(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);

    // Self-scoped: the AccessKeys listRule returns only keys this caller has
    // already claimed by proving the secret.
    const owned = await new AccessKeyMutator(pb).listByUser(user.id);
    if (owned.items.length === 0) {
      return Response.json({ items: [] });
    }

    const garage = GarageClient.fromEnv();

    // The gate. `ListBuckets` is one call for the whole cluster and carries no
    // usage or permissions, so it is far cheaper than the per-key fan-out it
    // guards.
    //
    // **The PocketBase side is read as a superuser, deliberately.** The Buckets
    // listRule is self-or-admin, so the caller's own client would only see their
    // own rows: a bucket somebody else had already claimed would read as
    // unclaimed here, be offered, and fail on click with a 409 that itself
    // reveals somebody has it. Only `garage_bucket_id` is read, and nothing
    // derived from it reaches the response except buckets the caller's own key
    // already owns in Garage — so this discloses nothing they could not read
    // with their own credentials; it only makes the filter complete.
    const superuserPb = await getPbAsSuperuser();
    const [allBuckets, claimedRows] = await Promise.all([
      buckets.listBuckets(garage),
      superuserPb
        .collection('Buckets')
        .getFullList({ batch: 500, fields: 'garage_bucket_id' }),
    ]);
    const claimed = new Set(claimedRows.map((r) => r.garage_bucket_id));
    const unclaimed = new Set(
      allBuckets.map((b) => b.id).filter((id) => !claimed.has(id))
    );
    if (unclaimed.size === 0) {
      return Response.json({ items: [] });
    }

    // Expired keys are dropped before the fan-out: a retired credential must
    // not offer buckets it can no longer reach, and skipping them also saves a
    // GetKeyInfo call apiece.
    const liveKeyIds = await liveKeyIdsFor(
      garage,
      owned.items.map((k) => k.garage_key_id)
    );
    const liveKeys = owned.items.filter((k) =>
      liveKeyIds.includes(k.garage_key_id)
    );
    if (liveKeys.length === 0) {
      return Response.json({ items: [] });
    }

    const settled = await Promise.allSettled(
      liveKeys.map((k) => keys.getKeyInfo(garage, k.garage_key_id))
    );

    // Bucket id -> the first of the caller's keys that owns it, restricted to
    // the unclaimed set from the gate above. A bucket owned by two of their keys
    // is still one entry, and one already claimed — by this caller or by anybody
    // else — is never offered: the intersection replaces what used to be a
    // second PocketBase read built by interpolating bucket ids into a filter.
    const candidates = new Map<string, string>();
    settled.forEach((result, i) => {
      const keyId = liveKeys[i].garage_key_id;
      if (result.status !== 'fulfilled') {
        console.error('[buckets] claimable lookup failed:', keyId);
        return;
      }
      for (const b of result.value.buckets ?? []) {
        if (!unclaimed.has(b.id)) continue;
        if (b.permissions?.owner === true && !candidates.has(b.id)) {
          candidates.set(b.id, keyId);
        }
      }
    });
    if (candidates.size === 0) {
      return Response.json({ items: [] });
    }

    // Only now, and only over buckets the caller can actually claim: the detail
    // call is what supplies the size and usage the card shows.
    const entries = [...candidates.entries()];
    const details = await Promise.allSettled(
      entries.map(([id]) => buckets.getBucketInfo(garage, { id }))
    );

    const items: ClaimableBucket[] = [];
    details.forEach((result, i) => {
      const [id, viaKeyId] = entries[i];
      if (result.status !== 'fulfilled') {
        console.error('[buckets] claimable detail failed:', id);
        return;
      }
      const info = result.value;
      items.push({
        id: info.id,
        name: info.globalAliases[0] ?? info.id,
        bytes: info.bytes ?? null,
        objects: info.objects ?? null,
        maxSize: info.quotas?.maxSize ?? null,
        viaKeyId,
      });
    });

    items.sort((a, b) => a.name.localeCompare(b.name));
    return Response.json({ items });
  } catch (err) {
    return errorResponse(err);
  }
}
