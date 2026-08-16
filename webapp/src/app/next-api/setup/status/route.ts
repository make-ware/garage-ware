/**
 * Is this instance set up yet?
 *
 * Unauthenticated on purpose: `/` and `/setup` must be able to route a visitor
 * who has no account yet, and the alternative — showing a sign-in page on a
 * brand-new deployment with no way to reach the setup flow — is the failure this
 * whole feature exists to remove.
 *
 * The trade-off is real and deliberately bounded: this tells an anonymous
 * visitor whether the instance has an administrator. That is useless without the
 * claim token, which is only ever accepted while the answer is "no". Keep this
 * payload to exactly these fields — anything richer becomes an unauthenticated
 * information leak.
 */
import { getPbAsSuperuser } from '@/lib/auth/server';
import { effectiveSignupMode } from '@/lib/setup/signup-mode';
import { expectedClaimToken, markClaimed } from '@/lib/setup/claim';
import { GarageClient } from '@/lib/garage';

export const dynamic = 'force-dynamic';

export async function GET() {
  // Default CLOSED. If we cannot determine whether an admin exists, saying
  // "unclaimed" would redirect every anonymous visitor of a live deployment to
  // /setup and invite them to take it over — the exact opposite of the safe
  // answer. `requireAdminOrUnclaimed` and the PocketBase signup hook both fail
  // closed on this same question; this must agree with them.
  let claimed = true;
  let pocketbaseOk = true;
  try {
    const pb = await getPbAsSuperuser();
    const admins = await pb.collection('Admins').getList(1, 1);
    claimed = admins.totalItems > 0;

    // Heal the upgrade path. An instance that predates the setup flow has
    // admins but no `claimed` marker, so the entrypoint would mint a pointless
    // claim token on every restart and print a banner telling its owner to
    // claim an instance they already own. The token is inert (the claim route
    // refuses on any non-empty Admins), but the banner is misleading. One page
    // load after upgrading, this quiets it.
    if (claimed && (await expectedClaimToken()) !== null) {
      await markClaimed();
    }
  } catch (err) {
    // A superuser that cannot authenticate is itself a setup problem; report it
    // rather than 500ing, since this route is what the setup page uses to
    // decide whether to render at all.
    console.error('[setup] status probe failed:', err);
    pocketbaseOk = false;
  }

  return Response.json({
    claimed,
    pocketbaseOk,
    signupMode: effectiveSignupMode(),
    needsGarageConfig: GarageClient.missingEnv().length > 0,
  });
}
