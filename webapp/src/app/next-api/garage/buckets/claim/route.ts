import { z } from 'zod';
import { AccessKeyMutator } from '@garage-ware/shared/mutators';
import { GarageClient, buckets, cluster } from '@/lib/garage';
import { liveKeyIdsFor } from '@/lib/storage/live-keys';
import {
  HttpError,
  errorResponse,
  getPbAsSuperuser,
  getServerUser,
} from '@/lib/auth/server';
import { getUserPosition } from '@/lib/storage/summary';
import { isUniqueViolation } from '@/lib/storage/unique-violation';
import { bytesToGib } from '@/lib/storage/units';
import { ownedBucketKeyFor } from '@/lib/storage/bucket-claim';

export const dynamic = 'force-dynamic';

/**
 * Claim an existing Garage bucket by owning a key that owns it.
 *
 * ## The proof is derived, not asserted
 *
 * A bucket id is not a credential — it is an identifier, and
 * `buckets/unallocated` already lists every unowned one to admins. So this
 * route asks Garage a question instead: *does the caller hold a key that Garage
 * itself marks `owner` on this bucket?* `GetBucketInfo` returns
 * `keys[] = { accessKeyId, permissions: { read, write, owner } }`, and the
 * caller's keys are the `AccessKeys` rows they have already claimed by proving
 * the secret at `POST /keys/claim`. One credential — the key secret —
 * bootstraps everything; bucket ownership is never separately asserted.
 *
 * `owner`, not read/write, and the distinction matters on a shared bucket: a
 * key with read/write holds a grant somebody gave it, which is not the same as
 * owning the thing. Garage already has a notion of bucket ownership and this
 * borrows it rather than inventing a second one. A bucket with no owner-flagged
 * key is simply not self-claimable — `POST /buckets/import` still covers it.
 *
 * ## Quota: adopt if it fits, otherwise zero
 *
 * The claim never fails on capacity — being unable to onboard your own bucket
 * because you have not been granted storage yet would defeat the point. So it
 * adopts Garage's live `maxSize` when the claimer has room for it, and records
 * `0` when they do not, saying so in the response. `syncQuotaToPb` will not
 * quietly raise it later either: it now refuses an adoption that would
 * over-allocate, which is what keeps this outcome stable rather than undone on
 * the next dashboard load.
 *
 * What that leaves, honestly: a bucket claimed at `0` reserves nothing against
 * its owner's grant while holding real bytes. That is an already-modelled state
 * — the `over-quota` segment on the storage chart, drawn and never clamped away
 * — and bringing stored bytes inside the invariant would be a
 * storage-accounting change, not a claim change.
 *
 * The layout read is **live**, never `@/lib/garage/cached`: it decides whether
 * capacity exists, which makes it a validator.
 */

const ClaimBody = z.object({
  garage_bucket_id: z.string().trim().min(1).max(128),
});

export interface ClaimBucketResponse {
  record: unknown;
  /** GiB actually recorded — 0 when the claimer had no room for Garage's. */
  quotaGb: number;
  /** True when Garage caps the bucket but the claimer could not reserve it. */
  quotaDeferred: boolean;
}

export async function POST(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const body = ClaimBody.parse(await req.json());

    const garage = GarageClient.fromEnv();
    const info = await buckets.getBucketInfo(garage, {
      id: body.garage_bucket_id,
    });

    // The caller's own AccessKeys rows, read through their own client: the
    // listRule is self-or-admin, so this returns exactly the keys they have
    // already proven. An admin reading it would see everyone's, which is why
    // the match below is against these rows and not against a user id.
    const ownedKeys = await new AccessKeyMutator(pb).listByUser(user.id);

    // **Expired keys prove nothing.** A retired credential must not still
    // confer the right to take ownership of a bucket — that would make expiry
    // a half-measure. One `ListKeys` call covers every key the caller has.
    const liveKeyIds = await liveKeyIdsFor(
      garage,
      ownedKeys.items.map((k) => k.garage_key_id)
    );
    const provingKey = ownedBucketKeyFor(info.keys, liveKeyIds);
    if (!provingKey) {
      throw new HttpError(
        403,
        'No unexpired access key of yours has owner permission on that bucket. Grant one owner permission in Garage, un-expire a retired key, or ask an admin to assign the bucket.'
      );
    }

    // Adopt Garage's quota when it fits; otherwise claim at zero.
    //
    // The position comes from the **materialized balances**, through the one
    // `computeSummaryFromBalances` every other reader uses — not from
    // `BucketMutator.sumAllocatedGb`, which reads a single page of a collection
    // that only grows and which nothing in the accounting path may use. Reading
    // the balance also collapses what were two queries into one, and `pb` is the
    // caller's own client asking about themselves, which the self-or-admin
    // listRule permits.
    const garageQuotaGb = bytesToGib(info.quotas?.maxSize ?? 0);
    let quotaGb = 0;
    let quotaDeferred = false;
    if (garageQuotaGb > 0) {
      // Layout-filtered: a claim on a node that has left the cluster values at
      // zero, so decommissioned hardware cannot back a newly claimed bucket.
      const layout = await cluster.getLayout(garage);
      const position = await getUserPosition(pb, user.id, layout);
      if (garageQuotaGb <= position.availableGb) {
        quotaGb = garageQuotaGb;
      } else {
        quotaDeferred = true;
      }
    }

    const name = info.globalAliases[0] ?? info.id;

    // Buckets' write rules are null; the superuser client is the only way in.
    const superuserPb = await getPbAsSuperuser();
    let record;
    try {
      record = await superuserPb.collection('Buckets').create({
        user: user.id,
        garage_bucket_id: info.id,
        name,
        quota_gb: quotaGb,
      });
    } catch (err) {
      // Two unique indexes, two different problems. Reporting a name collision
      // as "already claimed" would send the user looking for the wrong thing.
      if (isUniqueViolation(err, 'garage_bucket_id')) {
        throw new HttpError(409, 'That bucket has already been claimed');
      }
      if (isUniqueViolation(err, 'name')) {
        throw new HttpError(
          409,
          `A different bucket is already registered here as "${name}". Ask an admin to rename it.`
        );
      }
      throw err;
    }

    console.log(
      `[buckets] ${info.id} claimed by ${user.id} via key ${provingKey}`
    );
    const payload: ClaimBucketResponse = { record, quotaGb, quotaDeferred };
    return Response.json(payload);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
