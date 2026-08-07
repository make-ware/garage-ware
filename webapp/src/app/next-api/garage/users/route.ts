import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BucketMutator } from '@garage-ware/shared/mutators';
import { GarageClient, buckets, cluster } from '@/lib/garage';
import { getStorageSummariesForUsers } from '@/lib/storage/summary';
import {
  errorResponse,
  getPbAsSuperuser,
  HttpError,
  requireAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const InviteBody = z.object({
  email: z.string().email(),
  name: z.string().max(255).optional(),
});

export async function GET(req: Request) {
  try {
    const { pb } = await requireAdmin(req);
    const [result, allBuckets] = await Promise.all([
      pb.collection('Users').getList(1, 200, { sort: '-created' }),
      new BucketMutator(pb).getList(1, 1000),
    ]);

    const garage = GarageClient.fromEnv();
    const usageResults = await Promise.allSettled(
      allBuckets.items.map((b) =>
        buckets.getBucketInfo(garage, { id: b.garage_bucket_id })
      )
    );

    const userBytes = new Map<string, number>();
    allBuckets.items.forEach((b, i) => {
      const r = usageResults[i];
      if (r.status === 'fulfilled') {
        userBytes.set(
          b.user,
          (userBytes.get(b.user) ?? 0) + (r.value.bytes ?? 0)
        );
      }
    });

    // The layout is needed to value claims: one on a node that has left the
    // cluster backs nothing, and must not be counted here either — otherwise
    // this list disagrees with what each user sees on their own dashboard.
    const layout = await cluster.getLayout(garage);
    const summaries = await getStorageSummariesForUsers(
      pb,
      result.items.map((u) => u.id),
      layout
    );

    const items = result.items.map((u) => {
      const summary = summaries.get(u.id);
      return {
        id: u.id,
        email: (u as { email?: string }).email,
        name: (u as { name?: string }).name,
        claims_gb: summary?.claimsGb ?? 0,
        sent_gb: summary?.sentGb ?? 0,
        received_gb: summary?.receivedGb ?? 0,
        net_granted_gb: summary?.netGrantedGb ?? 0,
        allocated_gb: summary?.allocatedGb ?? 0,
        available_gb: summary?.availableGb ?? 0,
        used_bytes: userBytes.get(u.id) ?? 0,
        created: (u as { created?: string }).created,
      };
    });
    return Response.json({ items });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Invite a new user (admin only) using the "create & reset" pattern.
 *
 * PocketBase requires a password at creation time, so we create the record
 * with a throwaway cryptographically random password the invitee never learns,
 * then immediately trigger a password-reset email. The invitee clicks the link
 * (→ /reset-password?token=…) and chooses their real password, which also marks
 * their email verified. The throwaway password is never returned or stored.
 */
export async function POST(req: Request) {
  try {
    // Admin gate first, using the caller's own token.
    await requireAdmin(req);

    const body = InviteBody.parse(await req.json());
    const email = body.email.trim().toLowerCase();
    const name = body.name?.trim() || undefined;

    // Superuser client: creating an auth record and setting a name bypasses the
    // caller's own updateRule, and keeps working if we ever lock down the
    // public createRule to invite-only.
    const pb = await getPbAsSuperuser();

    // 43-char URL-safe secret (256 bits). Comfortably exceeds the 8-char
    // minimum; the invitee replaces it via the reset link and never sees it.
    const throwawayPassword = randomBytes(32).toString('base64url');

    let created: { id: string; email?: string; name?: string };
    try {
      created = await pb.collection('Users').create({
        email,
        password: throwawayPassword,
        passwordConfirm: throwawayPassword,
        ...(name ? { name } : {}),
        emailVisibility: false,
      });
    } catch (err) {
      // Unique-email index violation → the account already exists.
      const status =
        typeof err === 'object' && err !== null && 'status' in err
          ? (err as { status?: number }).status
          : undefined;
      if (status === 400) {
        throw new HttpError(409, `A user with ${email} already exists`);
      }
      throw err;
    }

    // Send the invitation (reuses the password-reset email template). If this
    // fails (e.g. SMTP down) the invitee has no way in, so roll back the record
    // to leave a clean state the admin can retry.
    try {
      await pb.collection('Users').requestPasswordReset(email);
    } catch (err) {
      try {
        await pb.collection('Users').delete(created.id);
      } catch (rollbackErr) {
        console.error(
          '[invite] failed to roll back user after email failure:',
          rollbackErr
        );
      }
      throw new HttpError(
        502,
        'User created but the invitation email could not be sent. Check SMTP configuration and try again.'
      );
    }

    return Response.json({
      record: { id: created.id, email: created.email, name: created.name },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
