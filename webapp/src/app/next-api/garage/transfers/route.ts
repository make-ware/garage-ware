import { z } from 'zod';
import { StorageTransferMutator } from '@garage-ware/shared/mutators';
import { GarageClient, cluster } from '@/lib/garage';
import { formatStorage } from '@/lib/format';
import { getUserGrantedGb } from '@/lib/storage/claims';
import {
  HttpError,
  errorResponse,
  getServerUser,
  isUserAdmin,
} from '@/lib/auth/server';
import { BucketMutator } from '@garage-ware/shared/mutators';

export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  to_user_email: z.string().email(),
  quota_gb: z.number().min(0.001),
  note: z.string().max(500).optional(),
  from_user_id: z.string().optional(),
});

export async function GET(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const url = new URL(req.url);
    const requestedUserId = url.searchParams.get('userId');
    const all = url.searchParams.get('all') === 'true';

    const transfers = new StorageTransferMutator(pb);

    if (all || (requestedUserId && requestedUserId !== user.id)) {
      const admin = await isUserAdmin(pb, user.id);
      if (!admin) throw new HttpError(403, 'Admin privileges required');

      if (all) {
        const result = await transfers.getList(1, 500);
        return Response.json({ items: result.items });
      }

      const [sent, received] = await Promise.all([
        transfers.listSentByUser(requestedUserId!),
        transfers.listReceivedByUser(requestedUserId!),
      ]);
      return Response.json({ sent: sent.items, received: received.items });
    }

    const [sent, received] = await Promise.all([
      transfers.listSentByUser(user.id),
      transfers.listReceivedByUser(user.id),
    ]);
    return Response.json({ sent: sent.items, received: received.items });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const body = CreateBody.parse(await req.json());

    let fromUserId = user.id;
    if (body.from_user_id && body.from_user_id !== user.id) {
      const admin = await isUserAdmin(pb, user.id);
      if (!admin) throw new HttpError(403, 'Admin privileges required');
      fromUserId = body.from_user_id;
    }

    // Resolve recipient by email. Admins can list all users; regular users can
    // only see themselves, so a non-admin reaching here always sets fromUserId
    // to their own id and looks up someone else — that lookup will 404 via the
    // Users listRule, which is the correct behaviour (users can't probe emails).
    let toUser: { id: string };
    try {
      toUser = (await pb
        .collection('Users')
        .getFirstListItem(
          `email = "${body.to_user_email.replace(/"/g, '')}"`
        )) as { id: string };
    } catch {
      throw new HttpError(
        404,
        `No user found with email "${body.to_user_email}"`
      );
    }

    if (fromUserId === toUser.id) {
      throw new HttpError(400, 'Cannot transfer storage to yourself');
    }

    const garage = GarageClient.fromEnv();
    const layout = await cluster.getLayout(garage);

    const [grantedGb, allocatedGb] = await Promise.all([
      getUserGrantedGb(pb, fromUserId, { onlyPresent: true, layout }),
      new BucketMutator(pb).sumAllocatedGb(fromUserId),
    ]);
    const availableGb = grantedGb - allocatedGb;

    if (body.quota_gb > availableGb) {
      throw new HttpError(
        400,
        `Not enough available capacity: ${formatStorage(availableGb)} available, ${formatStorage(body.quota_gb)} requested`
      );
    }

    const record = await pb.collection('StorageTransfers').create({
      from_user: fromUserId,
      to_user: toUser.id,
      quota_gb: body.quota_gb,
      note: body.note ?? '',
    });

    return Response.json({ record });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
