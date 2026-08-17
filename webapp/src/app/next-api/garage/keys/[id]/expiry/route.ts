import { z } from 'zod';
import { GarageClient, keys } from '@/lib/garage';
import { errorResponse } from '@/lib/auth/server';
import { loadOwnedKey } from '@/lib/auth/ownership';

export const dynamic = 'force-dynamic';

/**
 * Retire an access key, or bring it back.
 *
 * This is what "revoke" means in this app, and it replaced a `DELETE` that had
 * never worked. Expiring a key stops it authenticating against the S3 gateway —
 * Garage added expiration to standard S3 access keys in v2.0.0 precisely so an
 * operator can issue credentials that stop working — while leaving the key, its
 * bucket permissions, and its PocketBase row in place.
 *
 * **Nothing in PocketBase is written here.** The `AccessKeys` row is the record
 * that this key is yours; expiry is Garage-side state, read back through
 * `GET /keys` rather than mirrored into a column, in keeping with the
 * source-of-truth split. So there is no ordering problem and nothing to roll
 * back: one call, one outcome.
 *
 * **Un-expiry is not a convenience, it is the safety property.** Everything
 * destructive in this app is gated on being undoable or on destroying nothing;
 * a retire button with no way back would be the exact griefing lever the design
 * avoids elsewhere. `neverExpires` clears the expiration outright rather than
 * restoring a previous one — correct for every key this app creates, since it
 * sets none, and lossy for an imported key that carried a real future expiry.
 *
 * Ownership is the only gate, via `loadOwnedKey` (owner or admin). As with
 * every other gate in this app, the OTP and typed-name dialogs in front of it
 * are React booleans and are not server-enforced.
 */

const ExpiryBody = z.object({
  /** true retires the key; false brings it back. */
  expired: z.boolean(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const body = ExpiryBody.parse(await req.json());
    const { user, record } = await loadOwnedKey(req, id);

    const garage = GarageClient.fromEnv();
    const info = await keys.updateKey(garage, {
      id: record.garage_key_id,
      // An expiration in the past is what "expired now" means; Garage reports
      // the resulting state back as `expired`, which is what we return rather
      // than assuming the write landed.
      ...(body.expired
        ? { expiration: new Date().toISOString() }
        : { neverExpires: true }),
    });

    console.log(
      `[keys] ${record.garage_key_id} ${body.expired ? 'expired' : 'un-expired'} by ${user.id}`
    );
    return Response.json({ expired: info.expired ?? body.expired });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
