import { GarageClient, keys } from '@/lib/garage';
import { errorResponse } from '@/lib/auth/server';
import { loadOwnedKey } from '@/lib/auth/ownership';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const { record } = await loadOwnedKey(req, id);

    const garage = GarageClient.fromEnv();
    const info = await keys.getKeyInfo(garage, record.garage_key_id);
    return Response.json({ record, garage: info });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * There is deliberately **no DELETE here.**
 *
 * A user retires a key by expiring it — `POST /keys/[id]/expiry` — which stops
 * it working for S3 while keeping the key, its bucket permissions and its
 * PocketBase row as a record of what it could reach. That is the flow this app
 * serves: somebody rotating onto a new key, not responding to a compromise.
 *
 * Expiry is also **reversible from inside the app**, which is the point. A hard
 * delete is not, and a session-holder who could destroy every key of yours with
 * no way back is precisely the griefing this design refuses to enable. Hard
 * deletion stays with the Garage CLI, where it belongs — `garage key delete`.
 *
 * `keys.deleteKey` does exist and is real; its only caller is the create-path
 * rollback in `POST /next-api/garage/keys`, which has to be able to undo a
 * Garage key it just made.
 */
