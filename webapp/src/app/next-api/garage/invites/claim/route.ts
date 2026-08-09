import { GarageClient, cluster } from '@/lib/garage';
import { claimInvitesForUser } from '@/lib/storage/invites';
import { errorResponse, getServerUser } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

/**
 * Collect any storage invited to the caller's address.
 *
 * This is how an invite becomes a transfer. It runs from the dashboard on
 * load, which is what makes "sign up and the storage is there" true without a
 * PocketBase signup hook — and a hook could not do this job correctly anyway:
 * settling an invite needs the sender's *layout-filtered* position, and a PB
 * hook cannot reach Garage to learn which nodes are still in the layout. Doing
 * it here keeps the check identical to the one guarding a direct transfer.
 *
 * A POST rather than a GET because it writes. Idempotent — an invite leaves
 * `pending` on the first pass whether it is paid or refused — so the dashboard
 * calling it every load costs one indexed lookup on the quiet path.
 *
 * The layout is passed as a thunk so that quiet path really is one lookup: it
 * used to be fetched eagerly, which meant every dashboard load waited on a
 * live `GetClusterLayout` to find out there was nothing to collect. It stays
 * live rather than cached — settling an invite writes a transfer, so the
 * capacity check behind it must see the cluster as it is now.
 */
export async function POST(req: Request) {
  try {
    const { user } = await getServerUser(req);
    if (!user.email) {
      return Response.json({ claimed: [], failed: [], claimedGb: 0 });
    }

    const result = await claimInvitesForUser(user.id, user.email, () =>
      cluster.getLayout(GarageClient.fromEnv())
    );

    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
