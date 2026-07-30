import { z } from 'zod';
import { AccessKeyMutator } from '@garage-ware/shared/mutators';
import { GarageClient, keys } from '@/lib/garage';
import {
  HttpError,
  errorResponse,
  getServerUser,
  isUserAdmin,
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
        return Response.json({ items: result.items });
      }
      const result = await accessKeys.listByUser(requestedUserId!);
      return Response.json({ items: result.items });
    }

    const result = await accessKeys.listByUser(user.id);
    return Response.json({ items: result.items });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const body = CreateBody.parse(await req.json());

    const garage = GarageClient.fromEnv();
    const created = await keys.createKey(garage, { name: body.name });

    let pbRecord;
    try {
      pbRecord = await pb.collection('AccessKeys').create({
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
