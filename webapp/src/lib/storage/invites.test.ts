import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageInvite } from '@garage-ware/shared';
import type { ClusterLayout } from '@/lib/garage';

/**
 * The claim path is where an invite stops being a promise, so it is the one
 * place that could break the "may only give away unallocated capacity"
 * invariant. These tests drive it against a fake PocketBase and a scripted
 * position for each sender.
 */

const fake = {
  invites: [] as StorageInvite[],
  transfers: [] as Record<string, unknown>[],
  /** Sender id → capacity free to give, before anything is settled. */
  available: new Map<string, number>(),
};

vi.mock('@/lib/auth/server', () => ({
  getPbAsSuperuser: async () => ({
    collection(name: string) {
      if (name === 'StorageInvites') {
        return {
          getList: async () => ({
            items: fake.invites.filter((i) => i.status === 'pending'),
            page: 1,
            perPage: 500,
            totalItems: fake.invites.length,
            totalPages: 1,
          }),
          update: async (id: string, patch: Record<string, unknown>) => {
            const invite = fake.invites.find((i) => i.id === id)!;
            Object.assign(invite, patch);
            return invite;
          },
        };
      }
      if (name === 'StorageTransfers') {
        return {
          create: async (data: Record<string, unknown>) => {
            const record = { id: `tr${fake.transfers.length + 1}`, ...data };
            fake.transfers.push(record);
            return record;
          },
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  }),
  HttpError: class extends Error {},
}));

vi.mock('@/lib/storage/summary', () => ({
  // Mirrors the real read path closely enough for the guard: a sender's free
  // capacity drops as their invites are paid, which is exactly what the
  // sequential settlement has to observe.
  getUserStorageSummary: async (_pb: unknown, userId: string) => {
    const spent = fake.transfers
      .filter((t) => t.from_user === userId)
      .reduce((sum, t) => sum + (Number(t.quota_gb) || 0), 0);
    return { availableGb: (fake.available.get(userId) ?? 0) - spent };
  },
}));

const { claimInvitesForUser, normaliseEmail } =
  await import('@/lib/storage/invites');

const LAYOUT = { roles: [] } as unknown as ClusterLayout;

function invite(partial: Partial<StorageInvite>): StorageInvite {
  return {
    id: 'i1',
    from_user: 'sender',
    to_email: 'newcomer@example.com',
    quota_gb: 100,
    status: 'pending',
    created: '2026-08-01 10:00:00.000Z',
    updated: '',
    ...partial,
  } as StorageInvite;
}

beforeEach(() => {
  fake.invites = [];
  fake.transfers = [];
  fake.available = new Map();
});

describe('normaliseEmail', () => {
  it('lowercases and trims, so the claim lookup is a plain equality match', () => {
    expect(normaliseEmail('  Newcomer@Example.COM ')).toBe(
      'newcomer@example.com'
    );
  });
});

describe('claimInvitesForUser', () => {
  it('turns a pending invite into a transfer and settles the invite', async () => {
    fake.invites = [invite({ id: 'i1', quota_gb: 500 })];
    fake.available.set('sender', 1000);

    const result = await claimInvitesForUser(
      'newuser',
      'newcomer@example.com',
      LAYOUT
    );

    expect(result.claimedGb).toBe(500);
    expect(result.failed).toHaveLength(0);
    expect(fake.transfers).toEqual([
      {
        id: 'tr1',
        from_user: 'sender',
        to_user: 'newuser',
        quota_gb: 500,
        note: '',
      },
    ]);
    expect(fake.invites[0].status).toBe('claimed');
    expect(fake.invites[0].transfer_id).toBe('tr1');
    expect(fake.invites[0].settled_at).toBeTruthy();
  });

  it('refuses an invite the sender can no longer afford, and says why', async () => {
    fake.invites = [invite({ id: 'i1', quota_gb: 900 })];
    fake.available.set('sender', 100);

    const result = await claimInvitesForUser(
      'newuser',
      'newcomer@example.com',
      LAYOUT
    );

    expect(fake.transfers).toHaveLength(0);
    expect(result.claimedGb).toBe(0);
    expect(result.failed[0].reason).toMatch(/no longer has/);
    expect(fake.invites[0].status).toBe('failed');
    expect(fake.invites[0].failure_reason).toMatch(/no longer has/);
  });

  it('settles oldest first and re-checks between each one', async () => {
    // One sender promised 600 across two invites but only has 500 left. The
    // older invite is paid in full; the newer one cannot be, and must see the
    // capacity the first one consumed.
    fake.invites = [
      invite({
        id: 'newer',
        quota_gb: 400,
        created: '2026-08-05 10:00:00.000Z',
      }),
      invite({
        id: 'older',
        quota_gb: 200,
        created: '2026-08-01 10:00:00.000Z',
      }),
    ];
    fake.available.set('sender', 500);

    const result = await claimInvitesForUser(
      'newuser',
      'newcomer@example.com',
      LAYOUT
    );

    expect(result.claimed.map((c) => c.invite.id)).toEqual(['older']);
    expect(result.failed.map((f) => f.invite.id)).toEqual(['newer']);
    expect(result.claimedGb).toBe(200);
    // 500 − 200 = 300 left, and 400 was asked for.
    expect(result.failed[0].reason).toMatch(/300 GB|322.12 GB/);
  });

  it('pays every invite when the sender can cover them all', async () => {
    fake.invites = [
      invite({ id: 'a', quota_gb: 100, created: '2026-08-01 10:00:00.000Z' }),
      invite({
        id: 'b',
        quota_gb: 150,
        from_user: 'other',
        created: '2026-08-02 10:00:00.000Z',
      }),
    ];
    fake.available.set('sender', 1000);
    fake.available.set('other', 1000);

    const result = await claimInvitesForUser(
      'newuser',
      'newcomer@example.com',
      LAYOUT
    );

    expect(result.claimedGb).toBe(250);
    expect(fake.transfers).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });

  it('one unaffordable invite does not block the others', async () => {
    fake.invites = [
      invite({
        id: 'broke',
        from_user: 'poor',
        quota_gb: 900,
        created: '2026-08-01 10:00:00.000Z',
      }),
      invite({
        id: 'fine',
        from_user: 'rich',
        quota_gb: 300,
        created: '2026-08-02 10:00:00.000Z',
      }),
    ];
    fake.available.set('poor', 10);
    fake.available.set('rich', 1000);

    const result = await claimInvitesForUser(
      'newuser',
      'newcomer@example.com',
      LAYOUT
    );

    expect(result.claimed.map((c) => c.invite.id)).toEqual(['fine']);
    expect(result.failed.map((f) => f.invite.id)).toEqual(['broke']);
  });

  it('never transfers storage to the sender themselves', async () => {
    // Reachable if someone signs up with, or moves to, the address they invited.
    fake.invites = [invite({ id: 'self', from_user: 'newuser' })];
    fake.available.set('newuser', 1000);

    const result = await claimInvitesForUser(
      'newuser',
      'newcomer@example.com',
      LAYOUT
    );

    expect(fake.transfers).toHaveLength(0);
    expect(result.failed[0].reason).toMatch(/yourself/);
    expect(fake.invites[0].status).toBe('failed');
  });

  it('is a no-op when nothing is waiting', async () => {
    const result = await claimInvitesForUser(
      'newuser',
      'nobody@example.com',
      LAYOUT
    );
    expect(result).toEqual({ claimed: [], failed: [], claimedGb: 0 });
    expect(fake.transfers).toHaveLength(0);
  });

  it('is idempotent — a second pass finds nothing left pending', async () => {
    fake.invites = [invite({ id: 'i1', quota_gb: 100 })];
    fake.available.set('sender', 1000);

    await claimInvitesForUser('newuser', 'newcomer@example.com', LAYOUT);
    const second = await claimInvitesForUser(
      'newuser',
      'newcomer@example.com',
      LAYOUT
    );

    expect(second.claimedGb).toBe(0);
    expect(fake.transfers).toHaveLength(1);
  });
});
