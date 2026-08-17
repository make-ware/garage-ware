import 'server-only';
import { GarageClient, keys } from '@/lib/garage';

/**
 * Narrow a set of access key ids to the ones that are not expired.
 *
 * Bucket ownership is *derived* from holding a key Garage marks `owner` on that
 * bucket (see `bucket-claim.ts`), so once a key can be retired that derivation
 * has to care whether the key is still live. A key the user expired is a
 * credential they have deliberately taken out of service; letting it keep
 * conferring the right to claim buckets would make expiry a half-measure.
 *
 * One `ListKeys` call covers every key the caller holds, however many that is —
 * the same trick `GET /keys` uses to badge its list.
 *
 * **Fails closed.** If Garage cannot be reached, no key is treated as live, so
 * a claim is refused rather than granted on an unverified credential. The cost
 * is a claim that has to be retried; the alternative is claiming on the
 * strength of a key we could not check.
 */
export async function liveKeyIdsFor(
  garage: GarageClient,
  accessKeyIds: readonly string[]
): Promise<string[]> {
  if (accessKeyIds.length === 0) return [];
  try {
    const all = await keys.listKeys(garage);
    const expired = new Map(all.map((k) => [k.id, k.expired ?? false]));
    // A key Garage does not list at all is not live either — it has been
    // deleted out from under us, and `undefined` must not read as "fine".
    return accessKeyIds.filter((id) => expired.get(id) === false);
  } catch (err) {
    console.error('[keys] live-key lookup failed:', err);
    return [];
  }
}
