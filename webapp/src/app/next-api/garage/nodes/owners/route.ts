import { z } from 'zod';
import { NodeOwnerMutator } from '@garage-ware/shared/mutators';
import { GarageClient, cluster } from '@/lib/garage';
import {
  HttpError,
  errorResponse,
  getPbAsSuperuser,
  getServerUser,
  isUserAdmin,
} from '@/lib/auth/server';
import { writeTimelineActionRow } from '@/lib/cluster/timeline-write';
import { isFullNodeId, isNodeKey, nodeKey } from '@/lib/node-label';
import { featureNodeClaims } from '@/lib/setup/features';
import { isUniqueViolation } from '@/lib/storage/unique-violation';

export const dynamic = 'force-dynamic';

/**
 * Node ownership: who may grant storage sourced from which node.
 *
 * A user claims an unowned node by supplying its full Garage node id, and may
 * thereafter append StorageClaims entries against it — to themselves or to any
 * other user by email. Ownership decides *who may append a row*, never *how
 * much*: an owner's write runs through exactly the same
 * `assertClaimDeltaAllowed` invariants an admin's does, so the node capacity
 * ceiling is unchanged and unchangeable from here.
 *
 * ## The full node id is the credential
 *
 * This route is the reason nothing else in the app may emit one. A Garage node
 * id is 64 hex characters; its first 16 are the node **key**, which is public
 * and is what every payload, row and screen carries, and the remaining 48 are
 * the secret this route accepts as proof that you run the machine. So:
 *
 * - a **claim** — anyone naming themselves, and any non-admin — must carry a
 *   full id, never a key. Accepting a prefix there would hand ownership of any
 *   node to anyone who can read a page. This is the one admission test in the
 *   app that must not be relaxed;
 * - an **assignment** by an admin carries whatever the admin console has, which
 *   is the key and only ever the key: no route emits a full id and no page
 *   renders one. An admin needs no proof because there is nothing for the proof
 *   to add — they can already assign any node to any user and revoke it again.
 *   The test is conditional on the *caller*, never on the value submitted, so a
 *   non-admin can never talk their way out of it;
 * - either way the identifier is matched against the live layout and then
 *   **discarded**. What is stored is `nodeKey(id)`, because a credential kept in
 *   a database is a credential that can leak from one.
 *
 * A prefix was chosen over the `HMAC(node_id)` surrogate that CLAUDE.md and
 * this collection's schema used to propose: it matches what `garage status`
 * prints, so an operator recognises it, and it gives nothing away — 192 bits of
 * the id remain unknown.
 *
 * ## What it proves, and what it does not
 *
 * Node ids are gossiped between peers, and one authenticated `GetClusterStatus`
 * returns every node's. So possession proves *access to the Garage admin
 * surface* — in this deployment, the private VPN the CLI lives on — rather than
 * control of the particular machine. Between operators, claiming is therefore
 * first-claim-wins: the UNIQUE index settles it, the `node_owner_changed`
 * timeline row makes it attributable to a named human on a page every signed-in
 * user can read, and an admin can revoke. Those are the compensating controls;
 * the id being unguessable is what keeps everyone else out.
 *
 * ## No rate limiter, deliberately
 *
 * `setup/claim` has a backoff; this does not, and the difference is the size of
 * the secret. That token is 32 characters and its real guard is the
 * empty-`Admins` check rather than its secrecy. Here an attacker who has the
 * public key still has to produce 48 unknown hex characters. A speed bump would
 * be theatre. Rejected attempts are logged instead, which is what an operator
 * can actually act on.
 */

const CreateBody = z.object({
  /**
   * The node's full 64-character id, as `garage node id` prints it on the
   * machine — or, for an admin assigning a node, its 16-character key.
   * `<node_id>@<net_address>` — the form that command actually emits, and the
   * one Garage's own ConnectClusterNodes documents — is accepted and split,
   * because that is what an operator has on their clipboard.
   *
   * This refine is a **shape** test, not the admission test: which of the two
   * forms is good enough depends on who is asking, and that is decided in the
   * handler once the caller's admin status is known. Lowercased first so a
   * mixed-case paste fails on length rather than on an unrecognised character.
   */
  node_id: z
    .string()
    .trim()
    .transform((v) => v.split('@')[0].trim().toLowerCase())
    .refine((v) => isFullNodeId(v) || isNodeKey(v), {
      message:
        'That is not a Garage node id. Run `garage node id` on the node and paste what it prints.',
    }),
  note: z.string().max(500).optional(),
  /**
   * Admin-only: claim on another user's behalf. Assignment of an *unowned*
   * node only — the UNIQUE index makes an owned one a 409, and reassignment is
   * deliberately delete-then-create so every change leaves its own timeline
   * row, exactly as `StorageTransfers` has no update path.
   */
  user_id: z.string().min(1).optional(),
});

export async function GET(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const url = new URL(req.url);
    const all = url.searchParams.get('all') === 'true';

    const owners = new NodeOwnerMutator(pb);

    if (all) {
      const admin = await isUserAdmin(pb, user.id);
      if (!admin) throw new HttpError(403, 'Admin privileges required');
      const result = await owners.listAll();
      return Response.json({ items: result.items });
    }

    const result = await owners.listByUser(user.id);
    return Response.json({ items: result.items });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const { pb, user } = await getServerUser(req);
    const body = CreateBody.parse(await req.json());

    // Admin status decides two separate things here — whether the caller may
    // name somebody else as the owner, and whether a bare key is enough proof —
    // so it is resolved lazily and at most once. `??=` does not re-assign a
    // stored `false`, so a non-admin is asked about exactly once too.
    let cachedIsAdmin: boolean | undefined;
    const callerIsAdmin = async (): Promise<boolean> => {
      cachedIsAdmin ??= await isUserAdmin(pb, user.id);
      return cachedIsAdmin;
    };

    // The one door this flag closes: a user claiming a node for themselves.
    // Admin assignment (the key-based path) keeps working, and so does
    // everything an existing owner may already do — `assertNodeOwner` reads no
    // flag. Off means "admins decide who owns what", not "node ownership is
    // dark".
    if (!featureNodeClaims() && !(await callerIsAdmin())) {
      throw new HttpError(
        403,
        'Node claiming is disabled on this instance. Ask an administrator.'
      );
    }

    // Default to self; only ask whether the caller is an admin when they name
    // somebody else. Same escalation idiom as /next-api/garage/transfers.
    let ownerId = user.id;
    if (body.user_id && body.user_id !== user.id) {
      if (!(await callerIsAdmin()))
        throw new HttpError(403, 'Admin privileges required');
      ownerId = body.user_id;
    }

    // The admission test, conditional on the caller and never on the value. A
    // non-admin has to produce the credential; an admin has nothing to prove and
    // no way to prove it — the admin console holds keys, because no route in
    // this app emits a full id and no page renders one.
    const provedFullId = isFullNodeId(body.node_id);
    if (!provedFullId && !(await callerIsAdmin())) {
      // Logged with the key, which is public. A run of these is the signal that
      // somebody is guessing.
      console.warn(
        `[node-owners] claim refused: key ${body.node_id} submitted without a full id (user ${user.id})`
      );
      throw new HttpError(
        400,
        'A full 64-character node id is required — run `garage node id` on the node. The short key shown in the app is not enough.'
      );
    }

    // LIVE layout, never `@/lib/garage/cached`. This decides whether capacity
    // exists to own, which makes it a validator — and a validator must not act
    // on a layout that is a minute out of date.
    const garage = GarageClient.fromEnv();
    const layout = await cluster.getLayout(garage);

    // Exact match in whichever form was admitted above. A full id is compared
    // whole — nothing here resolves a *prefix*, which is the whole point of the
    // credential, so `resolveNodeKey` is deliberately not used — and a key is
    // compared key-to-key, the same normalisation every other node comparison in
    // the app uses.
    const role = layout.roles.find((r) =>
      provedFullId
        ? r.id.toLowerCase() === body.node_id
        : nodeKey(r.id) === body.node_id
    );
    if (!role) {
      // Logged because nothing else records a refused claim, and a run of these
      // is the only signal that someone is trying ids that are not theirs. The
      // key is safe to log; the rest of the submitted id is not, and is not.
      console.warn(
        `[node-owners] claim refused: no node ${nodeKey(body.node_id)} in layout (user ${user.id})`
      );
      throw new HttpError(404, 'No such node in the cluster layout');
    }
    if (!role.capacity || role.capacity <= 0) {
      // A gateway node backs no storage, so `assertClaimDeltaAllowed` would
      // refuse every positive delta against it and owning it would be inert.
      throw new HttpError(
        400,
        'That node has no declared capacity, so no storage can be claimed from it'
      );
    }

    // The credential has done its job. From here on the node is referred to by
    // its key, which is what gets stored and what every other collection and
    // payload in the app already uses.
    const key = nodeKey(role.id);

    // NodeOwners' write rules are null; the superuser client is the only way in.
    const superuserPb = await getPbAsSuperuser();

    let record;
    try {
      record = await superuserPb.collection('NodeOwners').create({
        user: ownerId,
        node_id: key,
        note: body.note || undefined,
      });
    } catch (err) {
      // The UNIQUE index on node_id is the authority on whether a node is free,
      // deliberately in place of a pre-flight existence check: a check-then-act
      // pair would let two simultaneous claims both pass. Let the insert fail
      // and translate it. (webapp/src/lib/setup/claim.ts had to reach for a
      // process-global mutex precisely because it had no such constraint.)
      if (isUniqueViolation(err, 'node_id')) {
        throw new HttpError(409, 'That node has already been claimed');
      }
      throw err;
    }

    const logged = await writeTimelineActionRow({
      kind: 'node_owner_changed',
      nodeId: key,
      title:
        ownerId === user.id
          ? 'Node ownership claimed'
          : 'Node ownership assigned',
      severity: 'info',
      // Raw ids, as this collection requires — the UI resolves them.
      previousValue: '',
      newValue: ownerId,
      actorId: user.id,
      actorEmail: user.email ?? '',
      logLabel: '[node-owners] node claimed but',
    });

    return Response.json({ record, logged });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
