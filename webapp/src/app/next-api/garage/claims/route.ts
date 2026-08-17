import { z } from 'zod';
import { StorageClaimMutator } from '@garage-ware/shared/mutators';
import { GarageClient, cluster } from '@/lib/garage';
import {
  assertClaimDeltaAllowed,
  loadClaimContext,
} from '@/lib/storage/claim-ledger';
import { actorHeaders } from '@/lib/storage/claim-write';
import { findUserIdByEmail } from '@/lib/storage/invites';
import { assertNodeOwner } from '@/lib/auth/ownership';
import { nodeKey } from '@/lib/node-label';
import {
  HttpError,
  errorResponse,
  getPbAsSuperuser,
  getServerUser,
  isUserAdmin,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const CreateBody = z
  .object({
    user_id: z.string().min(1).optional(),
    /**
     * Alternative to `user_id`, and the only form a node owner can use: the
     * Users listRule is self-or-admin, so a non-admin cannot resolve another
     * user's id from the browser. Resolved here as a superuser.
     */
    user_email: z.string().email().optional(),
    node_id: z.string().min(1).max(128),
    // Signed: a positive entry grants, a negative entry reclaims. Zero would be
    // a no-op row, so it is rejected rather than written to the ledger.
    quota_gb: z
      .number()
      .refine((v) => v !== 0, 'Adjustment must be a non-zero amount'),
    note: z.string().max(500).optional(),
  })
  .refine(
    (b) => Boolean(b.user_id) !== Boolean(b.user_email),
    'Provide exactly one of user_id or user_email'
  );

export async function GET(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const url = new URL(req.url);
    const requestedUserId = url.searchParams.get('userId');
    const all = url.searchParams.get('all') === 'true';
    const nodeId = url.searchParams.get('nodeId');

    const claims = new StorageClaimMutator(pb);

    if (nodeId) {
      // Key-to-key, as everywhere else in the app. `nodeKey` is idempotent, so
      // normalising a value that should already be a key costs nothing and
      // stops a full id or a mixed-case paste from missing the owner's own row.
      const wantedKey = nodeKey(nodeId);

      // A node's owner sees every claim on that node, including which other
      // users hold capacity there. That disclosure is inherent to managing a
      // node's capacity — you cannot be asked to keep a ceiling without being
      // shown what is under it — but it is real, and it is new information
      // reaching a non-admin. It is scoped to nodes they own and to claims on
      // those nodes; it reveals no user's position anywhere else in the cluster.
      await assertNodeOwner(pb, wantedKey, user.id);

      // Superuser, not the caller's client — the same reasoning as the guard in
      // POST below. StorageClaims' listRule is `user = self || admin`, so a
      // non-admin owner reading through their own client gets only their *own*
      // entries: the page would then under-count what the node has already
      // promised, overstate its free capacity, and offer storage that is not
      // there. Ownership has just been asserted, which is what makes the wider
      // read allowed.
      const superuserPb = await getPbAsSuperuser();
      const result = await new StorageClaimMutator(superuserPb).listByNode(
        wantedKey
      );
      return Response.json({ items: result.items });
    }

    if (all || (requestedUserId && requestedUserId !== user.id)) {
      const admin = await isUserAdmin(pb, user.id);
      if (!admin) throw new HttpError(403, 'Admin privileges required');
      if (all) {
        const result = await claims.getList(1, 500);
        return Response.json({ items: result.items });
      }
      const result = await claims.listByUser(requestedUserId!);
      return Response.json({ items: result.items });
    }

    const result = await claims.listByUser(user.id);
    return Response.json({ items: result.items });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const body = CreateBody.parse(await req.json());

    // Key-to-key, and computed **before** the ownership check rather than at
    // the layout match below. `NodeOwners.node_id` stores a key, so looking the
    // raw body value up would 403 the node's own owner the moment they sent
    // anything but the exact key casing the UI happens to produce — a full id
    // (which this route accepts, since it is 128 characters wide) always. Every
    // comparison from here on is against `wantedKey`; `nodeKey` is idempotent,
    // so a value that is already a key passes straight through.
    const wantedKey = nodeKey(body.node_id);

    // Superuser client, needed three times over: to resolve a recipient email,
    // to read the balances the guard depends on, and to make the write itself.
    // Memoized, so this is one client and one bcrypt, not three.
    const superuserPb = await getPbAsSuperuser();

    // Admin, or the owner of the node the capacity is sourced from. Ownership
    // gates *who may append a row*, never *how much* — the invariants below are
    // identical either way.
    const isAdmin = await isUserAdmin(pb, user.id);
    if (!isAdmin) {
      await assertNodeOwner(pb, wantedKey, user.id, false);
    }

    let targetUserId: string;
    if (body.user_id) {
      targetUserId = body.user_id;
    } else {
      const resolved = await findUserIdByEmail(superuserPb, body.user_email!);
      if (!resolved) {
        // No StorageInvite is written here. An invite is a *transfer* held in
        // escrow, and giving it a second meaning would put a promise inside the
        // per-node invariant. A sender who wants to reach a stranger claims the
        // capacity to themselves and hands it on through /transfers, which
        // already escrows, emails, and settles on signup.
        throw new HttpError(404, 'No account for that address');
      }
      targetUserId = resolved;
    }

    const garage = GarageClient.fromEnv();
    const [ctx, status] = await Promise.all([
      loadClaimContext(garage),
      cluster.getStatus(garage),
    ]);

    // The layout comes from Garage carrying full ids, so it is normalised on
    // its side too — the same thing `presentNodeIdSet` and `nodeUsableGbInLayout`
    // do. See lib/node-label.ts.
    const role = ctx.layout.roles.find((r) => nodeKey(r.id) === wantedKey);
    if (!role) {
      throw new HttpError(
        400,
        `Node ${wantedKey} is not present in the cluster layout`
      );
    }
    if (!role.capacity || role.capacity <= 0) {
      throw new HttpError(400, `Node ${wantedKey} has no declared capacity`);
    }

    // Superuser, not the caller's client. StorageNodeBalances is scoped
    // `user = self || admin`, so a node owner's own client would see only their
    // own rows: the node-capacity check would under-count what the node has
    // already promised and wave through an over-claim.
    await assertClaimDeltaAllowed(superuserPb, ctx, {
      userId: targetUserId,
      nodeId: wantedKey,
      deltaGb: body.quota_gb,
    });

    const node = status.nodes.find((n) => nodeKey(n.id) === wantedKey);
    // StorageClaims' write rules are null, so this is the only door. The real
    // actor rides along in headers for the audit hook — see claim-write.ts.
    const record = await superuserPb.collection('StorageClaims').create(
      {
        user: targetUserId,
        node_id: wantedKey,
        node_hostname: node?.hostname ?? undefined,
        node_zone: role.zone,
        quota_gb: body.quota_gb,
        note: body.note || undefined,
      },
      { headers: actorHeaders(user, isAdmin ? 'api' : 'node-owner') }
    );

    return Response.json({ record });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
