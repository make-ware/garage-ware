import { featureAssetClaims, featureNodeClaims } from '@/lib/setup/features';

/**
 * Which optional self-service features this deployment has enabled.
 *
 * A sibling of `/next-api/config`, not part of it, for the same reason
 * `/next-api/config/pricing` is: that route 500s deliberately when
 * GARAGE_S3_ENDPOINT is unset, and a feature-flag read must not inherit that
 * failure mode. Unauthenticated on purpose — these are public booleans the UI
 * uses to hide gated flows; the route handlers enforce them regardless.
 */

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    nodeClaims: featureNodeClaims(),
    assetClaims: featureAssetClaims(),
  });
}
