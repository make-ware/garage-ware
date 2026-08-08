import 'server-only';
import { StorageInviteMutator } from '@garage-ware/shared/mutators';
import type { StorageInvite } from '@garage-ware/shared';
import type { ClusterLayout } from '@/lib/garage';
import { formatStorage } from '@/lib/format';
import { getPbAsSuperuser } from '@/lib/auth/server';
import { getUserStorageSummary } from '@/lib/storage/summary';
import type { TypedPocketBase } from '@/lib/types';

/**
 * Storage invites: the half of a transfer whose recipient has no account yet.
 *
 * `StorageTransfers.to_user` is a relation, so a handoff has always needed the
 * recipient to exist. An invite holds the same handoff against an email
 * address until it does, and {@link claimInvitesForUser} converts it.
 *
 * The one thing to keep straight: **an invite promises, it does not reserve.**
 * No balance moves until it becomes a transfer, which is why the balance hooks
 * ignore StorageInvites entirely and why the claim re-checks the sender's
 * position instead of trusting the check made when the invite was written. The
 * cost of that choice is a promise that can turn out to be unpayable; the
 * benefit is that the four storage invariants keep exactly one definition
 * apiece. {@link getPendingInviteGb} is the mitigation on the writing side.
 */

/** Addresses are compared lowercased everywhere; store them that way too. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Find a user by email, bypassing collection rules.
 *
 * The Users listRule is `self or admin`, so a regular user's own client cannot
 * resolve a recipient — which is what made transfers admin-only in practice.
 * Reading as a superuser is what lets any user hand storage to a colleague.
 *
 * The privacy cost is real and worth naming: whoever calls this learns whether
 * an address has an account. It is confined to the transfer path, where the
 * caller must already know the address they are typing.
 */
export async function findUserIdByEmail(
  superuserPb: TypedPocketBase,
  email: string
): Promise<string | null> {
  try {
    const record = await superuserPb
      .collection('Users')
      .getFirstListItem(`email = "${normaliseEmail(email).replace(/"/g, '')}"`);
    return record.id;
  } catch {
    return null;
  }
}

/**
 * Emails for a set of user ids, for labelling transfer rows.
 *
 * Transfers store ids; a list that renders them raw is unreadable, and the
 * counterparty's address is something both parties to a handoff already know.
 * Missing ids are simply absent from the map — a deleted counterparty is a
 * dash in the UI, not an error.
 */
export async function resolveUserEmails(
  superuserPb: TypedPocketBase,
  userIds: readonly string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const emails = new Map<string, string>();
  if (unique.length === 0) return emails;

  const filter = unique
    .map((id) => `id = "${id.replace(/"/g, '')}"`)
    .join(' || ');
  const records = await superuserPb.collection('Users').getFullList({ filter });
  for (const record of records) {
    if (record.email) emails.set(record.id, record.email);
  }
  return emails;
}

/**
 * What a user has promised away but not yet paid.
 *
 * Subtracted from available capacity when writing a transfer or an invite, so
 * one gigabyte cannot be promised to five people at once. It is deliberately
 * *not* subtracted when allocating a bucket: that would put invites inside the
 * per-user storage invariant, which has one implementation in
 * `computeStorageSummary` and is not the place for a promise. A sender who
 * invites and then fills their buckets can therefore leave an invite
 * unpayable, and the claim reports it as `failed` rather than over-drawing.
 */
export async function getPendingInviteGb(
  pb: TypedPocketBase,
  userId: string
): Promise<number> {
  return new StorageInviteMutator(pb).sumPendingByFromUser(userId);
}

export interface ClaimedInvite {
  invite: StorageInvite;
  transferId: string;
}

export interface FailedInvite {
  invite: StorageInvite;
  reason: string;
}

export interface ClaimResult {
  claimed: ClaimedInvite[];
  failed: FailedInvite[];
  /** Total GB that actually landed. */
  claimedGb: number;
}

/**
 * Turn every pending invite addressed to a user into a real transfer.
 *
 * Idempotent: an invite leaves `pending` on the first pass either way, so
 * calling this on every dashboard load — which is how a new signup collects
 * what was waiting for them — costs one indexed lookup and nothing else.
 *
 * Invites are settled **oldest first and strictly in sequence**, because each
 * transfer changes the sender's available capacity and the next invite from
 * the same sender has to see it. Running them concurrently would let two
 * invites both pass a check that only one of them can afford.
 *
 * A sender who no longer has the capacity does not block the rest: that invite
 * is marked `failed` with a reason the sender can read, and the loop carries
 * on. Nothing here can push a user past the "may only give away unallocated
 * capacity" invariant — the same `availableGb` that guards a direct transfer
 * guards each conversion.
 */
export async function claimInvitesForUser(
  userId: string,
  email: string,
  layout: ClusterLayout
): Promise<ClaimResult> {
  const superuserPb = await getPbAsSuperuser();
  const invites = new StorageInviteMutator(superuserPb);
  const pending = await invites.listPendingByEmail(email);

  const result: ClaimResult = { claimed: [], failed: [], claimedGb: 0 };
  if (pending.items.length === 0) return result;

  // Oldest first: whoever promised first gets paid first when the sender can
  // no longer cover everything they promised.
  const ordered = [...pending.items].sort((a, b) =>
    a.created < b.created ? -1 : 1
  );

  for (const invite of ordered) {
    const amount = Number(invite.quota_gb) || 0;
    const settle = async (
      patch: Record<string, unknown>
    ): Promise<StorageInvite> =>
      (await superuserPb.collection('StorageInvites').update(invite.id, {
        ...patch,
        settled_at: new Date().toISOString(),
      })) as StorageInvite;

    if (invite.from_user === userId) {
      // Only reachable if the sender later signed up with the address they
      // invited, or changed their own address to it.
      result.failed.push({
        invite: await settle({
          status: 'failed',
          failure_reason: 'You cannot transfer storage to yourself.',
        }),
        reason: 'You cannot transfer storage to yourself.',
      });
      continue;
    }

    const summary = await getUserStorageSummary(
      superuserPb,
      invite.from_user,
      layout
    );

    if (amount > summary.availableGb) {
      const reason =
        `The sender no longer has ${formatStorage(amount)} free ` +
        `(${formatStorage(summary.availableGb)} available).`;
      result.failed.push({
        invite: await settle({ status: 'failed', failure_reason: reason }),
        reason,
      });
      continue;
    }

    const transfer = await superuserPb.collection('StorageTransfers').create({
      from_user: invite.from_user,
      to_user: userId,
      quota_gb: amount,
      note: invite.note ?? '',
    });

    result.claimed.push({
      invite: await settle({ status: 'claimed', transfer_id: transfer.id }),
      transferId: transfer.id,
    });
    result.claimedGb += amount;
  }

  return result;
}

/** Buckets a sender's own invites for display alongside their transfers. */
export async function listInvitesForSender(
  pb: TypedPocketBase,
  userId: string
): Promise<StorageInvite[]> {
  const result = await new StorageInviteMutator(pb).listByFromUser(userId);
  return result.items;
}
