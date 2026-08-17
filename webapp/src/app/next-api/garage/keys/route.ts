import { z } from 'zod';
import { AccessKeyMutator } from '@garage-ware/shared/mutators';
import { GarageClient, keys } from '@/lib/garage';
import {
  HttpError,
  errorResponse,
  getServerUser,
  isUserAdmin,
  getPbAsSuperuser,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  name: z.string().min(1).max(100),
});

export async function GET(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const url = new URL(req.url);
    const requestedUserId = url.searchParams.get('userId');
    const all = url.searchParams.get('all') === 'true';

    const accessKeys = new AccessKeyMutator(pb);

    if (all || (requestedUserId && requestedUserId !== user.id)) {
      const admin = await isUserAdmin(pb, user.id);
      if (!admin) throw new HttpError(403, 'Admin privileges required');
      if (all) {
        const result = await accessKeys.getList(1, 200, undefined, undefined, [
          'user',
        ]);
        return Response.json({ items: await withExpiry(result.items) });
      }
      const result = await accessKeys.listByUser(requestedUserId!);
      return Response.json({ items: await withExpiry(result.items) });
    }

    const result = await accessKeys.listByUser(user.id);
    return Response.json({ items: await withExpiry(result.items) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Attach Garage's `expired` flag to each row.
 *
 * `AccessKeys` deliberately has no `expired` column — expiry is Garage state
 * and mirroring it would be duplicating what Garage owns. `ListKeys` reports it
 * for every key in the cluster in **one** request, so the join costs a single
 * call however many keys the caller has, and no row goes stale.
 *
 * Degrades rather than fails: if Garage is unreachable the list still renders
 * with `expired: null`, which the UI shows as unknown. A key list that refuses
 * to load because the cluster is down would be the worse trade — the rows come
 * from PocketBase and are perfectly readable.
 */
async function withExpiry<T extends { garage_key_id: string }>(
  items: T[]
): Promise<(T & { expired: boolean | null })[]> {
  if (items.length === 0) return [];
  let expiredById = new Map<string, boolean>();
  try {
    const garage = GarageClient.fromEnv();
    const all = await keys.listKeys(garage);
    expiredById = new Map(all.map((k) => [k.id, k.expired ?? false]));
  } catch (err) {
    console.error('[keys] expiry lookup failed:', err);
    return items.map((item) => ({ ...item, expired: null }));
  }
  return items.map((item) => ({
    ...item,
    expired: expiredById.get(item.garage_key_id) ?? null,
  }));
}

export async function POST(req: Request) {
  try {
    // No `pb`: AccessKeys' write rules are null, so the create below is a
    // superuser write.
    const { user } = await getServerUser(req);
    const body = CreateBody.parse(await req.json());

    const garage = GarageClient.fromEnv();
    const created = await keys.createKey(garage, { name: body.name });

    let pbRecord;
    try {
      const writePb = await getPbAsSuperuser();
      pbRecord = await writePb.collection('AccessKeys').create({
        user: user.id,
        garage_key_id: created.accessKeyId,
        name: body.name,
      });
    } catch (err) {
      // Roll back the Garage-side key so we don't leak orphaned credentials.
      try {
        await keys.deleteKey(garage, created.accessKeyId);
      } catch (rollbackErr) {
        console.error('[keys] rollback delete failed:', rollbackErr);
      }
      throw err;
    }

    return Response.json({
      record: pbRecord,
      garage_key_id: created.accessKeyId,
      secret_access_key: created.secretAccessKey,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
