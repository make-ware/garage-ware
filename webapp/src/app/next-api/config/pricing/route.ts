import { RATES_AS_OF } from '@/lib/pricing/rates';
import { pricingConfig } from '@/lib/pricing/config';

/**
 * Public runtime pricing config for the dashboard's cost card.
 *
 * A **sibling** of `/next-api/config`, deliberately not part of it. That route
 * returns a 500 when `GARAGE_S3_ENDPOINT` is unset, and that failure is
 * intentional — but it has nothing to do with what a terabyte costs, and
 * folding these values into it would blank a value/ROI panel on any deployment
 * that has not configured an S3 gateway. Nesting under `config/` still says
 * "public runtime config, like the S3 one", which is the property they actually
 * share; a separate route file inherits none of the parent's failure behaviour.
 *
 * No auth gate, for the same reason the parent has none: these are published
 * reference prices and an operator's own hardware cost, both public, and
 * requiring a PocketBase session would couple config loading to auth for zero
 * security benefit.
 *
 * It cannot fail — every value has a documented default.
 */

export const dynamic = 'force-dynamic';

export function GET() {
  const config = pricingConfig();
  // Deliberately does NOT return an effective $/GB/month. That rate depends on
  // the cluster's replication factor, which the browser already holds from
  // /next-api/garage/cluster/nodes — deriving it here too would give the card
  // two sources for one number and a way for them to disagree.
  return Response.json({
    garageUsdPerTb: config.garageUsdPerTb,
    hardwareLifespanYears: config.hardwareLifespanYears,
    ratesAsOf: RATES_AS_OF,
  });
}
