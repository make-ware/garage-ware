import 'server-only';
import {
  DEFAULT_GARAGE_USD_PER_TB,
  DEFAULT_HARDWARE_LIFESPAN_YEARS,
  type PricingConfig,
} from './rates';

/**
 * The operator-configurable half of the cost model, read from the server-side
 * env at request time.
 *
 * The twin of `object-quota.ts`: the arithmetic lives in `rates.ts` where the
 * browser can reach it, and this module does nothing but read the environment
 * and inject the values. Read at request time (not module load) so it stays a
 * plain runtime env — one image, any deployment, no rebuild — exactly as
 * `GARAGE_S3_ENDPOINT` and `GARAGE_AVG_OBJECT_SIZE_MB` are.
 *
 * Only these two values are configurable. The third-party reference rates are
 * published prices, not a property of this deployment, so they stay hardcoded
 * in `rates.ts` beside the date they were taken.
 */

/** Parse a positive finite number from an env string, or null. */
function positiveNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * The deployment's pricing config, falling back to the documented defaults.
 *
 * Never throws and never returns a partial config: an unset or malformed env
 * var falls back rather than failing, because the card is enrichment and a
 * typo'd number is not a reason for the dashboard to lose a panel.
 */
export function pricingConfig(): PricingConfig {
  return {
    garageUsdPerTb:
      positiveNumber(process.env.GARAGE_COST_USD_PER_TB) ??
      DEFAULT_GARAGE_USD_PER_TB,
    hardwareLifespanYears:
      positiveNumber(process.env.GARAGE_HARDWARE_LIFESPAN_YEARS) ??
      DEFAULT_HARDWARE_LIFESPAN_YEARS,
  };
}
