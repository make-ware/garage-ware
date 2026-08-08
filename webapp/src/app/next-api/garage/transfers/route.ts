import { z } from 'zod';
import {
  StorageTransferMutator,
  StorageInviteMutator,
} from '@garage-ware/shared/mutators';
import type { StorageInvite, StorageTransfer } from '@garage-ware/shared';
import { GarageClient, cluster } from '@/lib/garage';
import { formatStorage } from '@/lib/format';
import { getUserStorageSummary } from '@/lib/storage/summary';
import {
  findUserIdByEmail,
  getPendingInviteGb,
  normaliseEmail,
  resolveUserEmails,
} from '@/lib/storage/invites';
import {
  HttpError,
  errorResponse,
  getPbAsSuperuser,
  getServerUser,
  isUserAdmin,
} from '@/lib/auth/server';
import type { LabelledTransfer, TypedPocketBase } from '@/lib/types';

export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  to_user_email: z.string().email(),
  quota_gb: z.number().min(0.001),
  note: z.string().max(500).optional(),
  from_user_id: z.string().optional(),
});

/**
 * Attach counterparty emails.
 *
 * Transfers store user ids and the dashboard used to render them raw, which
 * told the recipient nothing about who had sent them a terabyte. The lookup
 * runs as a superuser because the Users listRule is self-or-admin — see
 * `lib/storage/invites.ts` for why that is acceptable here.
 */
async function labelTransfers(
  superuserPb: TypedPocketBase,
  sent: StorageTransfer[],
  received: StorageTransfer[]
): Promise<{ sent: LabelledTransfer[]; received: LabelledTransfer[] }> {
  const emails = await resolveUserEmails(superuserPb, [
    ...sent.map((t) => t.to_user),
    ...received.map((t) => t.from_user),
  ]);
  return {
    sent: sent.map((t) => ({ ...t, to_email: emails.get(t.to_user) })),
    received: received.map((t) => ({
      ...t,
      from_email: emails.get(t.from_user),
    })),
  };
}

export async function GET(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const url = new URL(req.url);
    const requestedUserId = url.searchParams.get('userId');
    const all = url.searchParams.get('all') === 'true';

    const transfers = new StorageTransferMutator(pb);

    if (all) {
      const admin = await isUserAdmin(pb, user.id);
      if (!admin) throw new HttpError(403, 'Admin privileges required');
      const result = await transfers.getList(1, 500);
      return Response.json({ items: result.items });
    }

    let targetUserId = user.id;
    if (requestedUserId && requestedUserId !== user.id) {
      const admin = await isUserAdmin(pb, user.id);
      if (!admin) throw new HttpError(403, 'Admin privileges required');
      targetUserId = requestedUserId;
    }

    const [sent, received, invites] = await Promise.all([
      transfers.listSentByUser(targetUserId),
      transfers.listReceivedByUser(targetUserId),
      new StorageInviteMutator(pb).listByFromUser(targetUserId),
    ]);

    // Emails are a label, not data — if the superuser credentials are absent
    // or wrong, serve the rows unlabelled rather than failing the request. The
    // dashboard renders "Unknown sender"; a 500 here would take the whole page
    // down over cosmetics. The POST path below deliberately does *not* degrade:
    // there, a failed lookup is indistinguishable from "no such account", and
    // guessing wrong writes an invite for someone who already has one.
    let labelled = { sent: sent.items, received: received.items } as {
      sent: LabelledTransfer[];
      received: LabelledTransfer[];
    };
    try {
      const superuserPb = await getPbAsSuperuser();
      labelled = await labelTransfers(superuserPb, sent.items, received.items);
    } catch (err) {
      console.warn('[transfers] counterparty emails unavailable:', err);
    }

    return Response.json({ ...labelled, invites: invites.items });
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

    // Resolving the recipient needs to bypass the Users listRule
    // (self-or-admin), or only admins could ever send a transfer.
    const superuserPb = await getPbAsSuperuser();
    const email = normaliseEmail(body.to_user_email);
    const toUserId = await findUserIdByEmail(superuserPb, email);

    if (toUserId === fromUserId) {
      throw new HttpError(400, 'Cannot transfer storage to yourself');
    }

    const garage = GarageClient.fromEnv();
    const layout = await cluster.getLayout(garage);

    const [summary, promisedGb] = await Promise.all([
      getUserStorageSummary(pb, fromUserId, layout),
      getPendingInviteGb(pb, fromUserId),
    ]);

    // Invites promise capacity without reserving it, so they have to come off
    // the top here — otherwise the same gigabyte could be promised to five
    // people, and four of those promises would fail at claim time.
    const availableGb = summary.availableGb - promisedGb;

    if (body.quota_gb > availableGb) {
      const promisedNote =
        promisedGb > 0
          ? ` (${formatStorage(promisedGb)} of your capacity is already promised to pending invites)`
          : '';
      throw new HttpError(
        400,
        `Not enough available capacity: ${formatStorage(Math.max(availableGb, 0))} available, ${formatStorage(body.quota_gb)} requested${promisedNote}`
      );
    }

    // Known address → a transfer lands immediately. Unknown → an invite waits
    // for them to sign up, and the PB hook on StorageInvites emails them.
    if (toUserId) {
      const record = await pb.collection('StorageTransfers').create({
        from_user: fromUserId,
        to_user: toUserId,
        quota_gb: body.quota_gb,
        note: body.note ?? '',
      });
      return Response.json({ kind: 'transfer', record });
    }

    const invite: StorageInvite = (await pb
      .collection('StorageInvites')
      .create({
        from_user: fromUserId,
        to_email: email,
        quota_gb: body.quota_gb,
        note: body.note ?? '',
        status: 'pending',
      })) as StorageInvite;

    return Response.json({ kind: 'invite', record: invite });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
