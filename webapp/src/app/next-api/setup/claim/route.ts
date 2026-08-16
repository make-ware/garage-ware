/**
 * Claim the first administrator seat.
 *
 * `Admins.createRule` requires you to already be an admin, so the first one
 * cannot be created through the normal API. This route is the bootstrap: a
 * signed-in caller who presents the token the container printed to its logs
 * gets the `Admins` row.
 *
 * The guard that matters is the claimed check, not the token — see
 * lib/setup/claim.ts. The token proves you can read this deployment's logs or
 * its /data volume; the claimed check makes it single-use in effect.
 */
import { z } from 'zod';
import {
  describeFailure,
  evaluateClaim,
  markClaimed,
  type AdminCounter,
} from '@/lib/setup/claim';
import {
  errorResponse,
  getPbAsSuperuser,
  getServerUser,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const ClaimBody = z.object({ token: z.string().min(1, 'A token is required') });

/**
 * Make a wrong token cost something. A 32-char alphanumeric token is not
 * brute-forceable regardless, so this is a courtesy rather than the defence —
 * the defence is that the claim is refused outright once an admin exists.
 *
 * The delay runs inside the serialisation lock below, so failed attempts queue
 * behind one another rather than all sleeping in parallel. Note the counter is
 * process-global, not per-IP: it is a speed bump, not a rate limiter.
 */
let consecutiveFailures = 0;
const MAX_BACKOFF_MS = 2_000;

async function penalise(): Promise<void> {
  consecutiveFailures = Math.min(consecutiveFailures + 1, 8);
  const delay = Math.min(consecutiveFailures * 250, MAX_BACKOFF_MS);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Serialise claim attempts within this process.
 *
 * The guard is read-then-write — count `Admins`, then create a row — so two
 * requests arriving together could both observe an empty collection and both
 * be granted. Neither is an escalation (both had to present the valid token),
 * but "the first claim wins and the instance is then closed" should be true
 * rather than nearly true.
 *
 * This closes the window WITHIN one process, which is the single-container
 * deployment this image ships. It does NOT close it across replicas sharing one
 * PocketBase — and `SETUP_CLAIM_TOKEN` exists precisely so several replicas can
 * be handed the same token. There, two simultaneous claims can still produce
 * two admins. Both had the token, so nothing is granted that the token did not
 * already authorise; closing it properly would need a uniqueness constraint in
 * the database rather than a lock here.
 */
let claimQueue: Promise<unknown> = Promise.resolve();

function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const run = claimQueue.then(fn, fn);
  // Keep the chain alive regardless of outcome; never let a rejection here
  // become an unhandled rejection.
  claimQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function POST(req: Request) {
  try {
    // Signed in, so we know whom to promote. Anyone may attempt this — the
    // token is what authorises it, and requiring an account first means the
    // claim lands on a real identity rather than creating one.
    const { user } = await getServerUser(req);
    const body = ClaimBody.parse(await req.json());

    const pb = await getPbAsSuperuser();
    const counter: AdminCounter = {
      countAdmins: async () =>
        (await pb.collection('Admins').getList(1, 1)).totalItems,
    };

    const outcome = await serialise(async () => {
      const decision = await evaluateClaim(counter, body.token);
      if (!decision.ok) {
        // Inside the lock, so repeated wrong guesses queue rather than run
        // concurrently.
        if (decision.failure === 'bad-token') await penalise();
        return decision;
      }
      // Created as superuser: the collection's own createRule is exactly what
      // we cannot satisfy yet. Inside the lock, so the count above still holds.
      await pb.collection('Admins').create({ user: user.id });
      await markClaimed();
      return decision;
    });

    if (!outcome.ok) {
      const { status, error } = describeFailure(outcome.failure!);
      return Response.json({ error }, { status });
    }
    consecutiveFailures = 0;

    console.log(`[setup] admin claimed by ${user.email ?? user.id}`);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.issues[0].message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
