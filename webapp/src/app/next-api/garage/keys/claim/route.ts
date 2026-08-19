import { z } from 'zod';
import { GarageClient, keys } from '@/lib/garage';
import {
  HttpError,
  errorResponse,
  getPbAsSuperuser,
  getServerUser,
} from '@/lib/auth/server';
import { createBackoff } from '@/lib/auth/backoff';
import { featureAssetClaims } from '@/lib/setup/features';
import { isUniqueViolation } from '@/lib/storage/unique-violation';

export const dynamic = 'force-dynamic';

/**
 * Claim an existing Garage access key by proving you hold its secret.
 *
 * The secondary onboarding path: keys made outside the app — with the Garage
 * CLI, or before this control plane existed — have no PocketBase owner, and
 * until now the only way to attach one was an admin picking a user off a list
 * in `/admin/keys` with no proof of anything. Here the cluster does the
 * checking.
 *
 * ## The secret is the credential, and it is never kept
 *
 * `verifyKeySecret` fetches the real secret from Garage, compares it in
 * constant time, and returns a boolean — the secret never becomes a value this
 * handler can hold, so it cannot be logged, echoed or stored. `AccessKeys` has
 * no column for one and never did. The only thing persisted is the access key
 * *id*, which is public.
 *
 * ## One answer for "no such key" and "wrong secret"
 *
 * Both are the same 403 with the same sentence. Distinguishing them would make
 * this an oracle for which access key ids exist, and access key ids are exactly
 * what an attacker would enumerate first — `garage key list` is one command,
 * and `keys/unallocated` already publishes them to admins. `verifyKeySecret`
 * returns `false` for a missing key rather than throwing, which is what makes
 * the single answer the natural way to write this rather than a discipline to
 * remember.
 *
 * **The ordering is the mirror of `setup/claim.ts`, deliberately.** That route
 * checks *claimed-before-token*, so an already-claimed instance answers
 * identically whether or not you guessed. Here proof comes first and state
 * second: someone who has produced the secret has earned the real answer, and
 * "this key is already claimed" is only disclosed to them. Until they prove it,
 * every outcome looks the same.
 *
 * ## Self only
 *
 * No `user_id` escalation, unlike `nodes/owners`. An admin assigning an
 * orphaned key cannot know its secret, so a unified route would need an
 * "if admin, skip the proof" branch — a conditional admission test, which is
 * the exact shape that goes wrong. Admins keep `POST /keys/import`; two
 * authorities, two doors.
 */

const ClaimBody = z.object({
  access_key_id: z.string().trim().min(1).max(128),
  secret_access_key: z.string().trim().min(1).max(512),
});

/** Said for a key that does not exist AND for a key whose secret is wrong. */
const REFUSED =
  'That access key id and secret do not match a key on this cluster.';

const backoff = createBackoff();

export async function POST(req: Request) {
  try {
    const { user } = await getServerUser(req);
    // FEATURE_ASSET_CLAIMS off: refuse before touching the body, the backoff or
    // Garage — no work, no oracle. There is no admin bypass here on purpose:
    // an admin cannot know the secret, and their door is POST /keys/import.
    if (!featureAssetClaims()) {
      throw new HttpError(
        403,
        'Claiming existing keys is disabled on this instance. Ask an administrator to import the key for you.'
      );
    }
    const body = ClaimBody.parse(await req.json());

    const garage = GarageClient.fromEnv();
    const proven = await keys.verifyKeySecret(
      garage,
      body.access_key_id,
      body.secret_access_key
    );

    if (!proven) {
      // The access key id is safe to log — it is public, and a run of these is
      // the only signal that someone is guessing. The submitted secret is not
      // logged anywhere, at any level, ever.
      console.warn(
        `[keys] claim refused for ${body.access_key_id} (user ${user.id})`
      );
      await backoff.penalise();
      throw new HttpError(403, REFUSED);
    }
    backoff.reset();

    // Proven — so the name is worth reading back for a sensible default, and
    // from here on failures may say what they actually are.
    const info = await keys.getKeyInfo(garage, body.access_key_id);

    // AccessKeys' write rules are null; the superuser client is the only way in.
    const superuserPb = await getPbAsSuperuser();
    let record;
    try {
      record = await superuserPb.collection('AccessKeys').create({
        user: user.id,
        garage_key_id: body.access_key_id,
        name: info.name || undefined,
      });
    } catch (err) {
      // The UNIQUE index on garage_key_id is the authority on whether a key is
      // free, deliberately in place of a pre-flight existence check: a
      // check-then-act pair would let two simultaneous claims both pass. The
      // import route still makes that mistake.
      if (isUniqueViolation(err, 'garage_key_id')) {
        throw new HttpError(409, 'That access key has already been claimed');
      }
      throw err;
    }

    console.log(`[keys] ${body.access_key_id} claimed by ${user.id}`);
    return Response.json({ record });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
