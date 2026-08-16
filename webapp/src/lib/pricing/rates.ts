import { bytesToTb } from '@/lib/storage/units';

/**
 * What a storage footprint would cost, here versus in the cloud.
 *
 * Deliberately without `import 'server-only'` — the dashboard card renders this
 * arithmetic in the browser, and a second hand-rolled copy inside a component
 * is exactly how the card and its tests would come to disagree. Only the env
 * read (`GARAGE_COST_USD_PER_TB`, `GARAGE_HARDWARE_LIFESPAN_YEARS`) stays
 * server-side, in `config.ts`, which injects the result into these functions —
 * the same split as `object-cap.ts` / `object-quota.ts`.
 *
 * It lives in `lib/pricing/` rather than `lib/storage/` for the reason
 * `lib/metrics/data-coverage.ts` does: **nothing in the storage-accounting path
 * may import it.** A dollar figure that can typecheck its way into a ledger
 * call site is a bug with no upper bound, and a capacity-denominated cost
 * module sitting next to `ledger-math.ts` is an open invitation to write one.
 *
 * ## Units: bytes in, decimal TB for the rates
 *
 * Every function takes **bytes**. That is not the codebase's default — every
 * field named `*Gb` / `*_gb` in the ledger, the balances and `StorageSummary`
 * holds **binary GiB** — which is precisely why this module refuses to speak in
 * "GB" at its edges. Callers convert once, explicitly, with the bridges in
 * `units.ts` (`gibToBytes`).
 *
 * Rates are quoted per **decimal TB (10^12 bytes)** per month. Decimal because
 * the dashboard already renders "36 TB" in decimal SI via `formatBytes`, so a
 * reader multiplying the figure on screen by the quoted $/TB has to land on the
 * number the card shows; pricing in TiB would make the card's own arithmetic
 * unverifiable by the person reading it. Per **TB** rather than per GB because
 * every rate involved then lands in plain dollars — $23.00, $6.95, $1.10 —
 * instead of the three-orders-of-magnitude spread of sub-cent GB rates that
 * needed its own formatter to avoid rounding the cluster's own row to "$0.00".
 */

/**
 * Fraction of the footprint assumed downloaded each month.
 *
 * One twelfth: over a year a user reads back everything they store, once. It is
 * an assumption, not a measurement — this app has no egress telemetry of any
 * kind (there is no bandwidth or request metric anywhere in the schema) — so
 * the card states it in visible copy rather than burying it.
 *
 * It is also the conservative end of plausible. A backup target is read far
 * less; anything serving traffic is read far more, and egress is precisely
 * where the commercial gap widens, so a higher assumption would only favour
 * this cluster further.
 */
export const EGRESS_FRACTION_PER_MONTH = 1 / 12;

/**
 * When the reference rates below were last checked against each provider's own
 * pricing page.
 *
 * Deliberately a month, not a date, and deliberately not run through
 * `formatPbDate`: that helper is for PocketBase timestamps, which are real UTC
 * instants, and a bare `YYYY-MM-DD` fed through it parses as UTC midnight and
 * then renders in local time — displaying "Aug 14" for a value of `2026-08-15`
 * anywhere west of Greenwich. Published rates do not change daily, so month
 * granularity is both sufficient and immune to that.
 */
export const RATES_AS_OF = 'August 2026';

/** Everything needed to price one footprint at one provider. */
export interface Rate {
  /** Storage, USD per decimal TB per month. */
  usdPerTbMonth: number;
  /** Egress, USD per decimal TB downloaded. */
  egressUsdPerTb: number;
  /** Egress allowed free each month as a multiple of what is stored. */
  freeEgressMultiple: number;
  /** Egress allowed free each month as a flat figure, in TB. */
  freeEgressTb: number;
}

/** A commercial reference the local cluster is measured against. */
export interface ReferenceRate extends Rate {
  key: string;
  label: string;
  /** Shown on hover; states what the figures are and what they exclude. */
  note: string;
}

/**
 * Checked against each provider's own pricing page on {@link RATES_AS_OF}.
 *
 * **Every row names a real company, so every figure must be that company's
 * actual published rate.** An earlier cut carried an invented "blended cloud"
 * rate of $200/TB/month — ~8.7x S3's list price — which had to be labelled
 * generically precisely because attributing it to anyone would have been a
 * false statement. Using the real numbers removed the need for the fiction, and
 * the comparison still holds comfortably. Do not reintroduce a made-up rate to
 * widen the gap.
 *
 * Two providers, not three: one premium and one budget bracket the market, and
 * a second budget row said nothing the first had not.
 */
export const REFERENCE_RATES: readonly ReferenceRate[] = Object.freeze([
  Object.freeze({
    key: 's3',
    label: 'Amazon S3',
    usdPerTbMonth: 23.0, // $0.023/GB, first 50 TB, US East (N. Virginia)
    egressUsdPerTb: 90.0, // $0.09/GB to the internet, first 10 TB/month
    freeEgressMultiple: 0,
    freeEgressTb: 0.1, // 100 GB/month, across all services and regions
    note: 'S3 Standard list price, first 50 TB, US East (N. Virginia). Egress to the internet is $0.09/GB after the first 100 GB each month. Per-request charges are not included.',
  }),
  Object.freeze({
    key: 'backblaze',
    label: 'Backblaze B2',
    usdPerTbMonth: 6.95,
    egressUsdPerTb: 10.0, // $0.01/GB
    freeEgressMultiple: 3, // free up to 3x what is stored, each month
    freeEgressTb: 0,
    note: 'B2 list price, $6.95/TB/month. Egress is free up to three times what you store each month, then $0.01/GB — so the download assumed here costs nothing.',
  }),
]);

/** The dearest reference row — the one the headline saving quotes. */
export const HEADLINE_RATE = REFERENCE_RATES[0];

/**
 * One-time cost per decimal TB of **raw disk**, when the operator has not set
 * one. This is the price of the drive, not of a usable terabyte — the
 * replication factor is applied separately, in {@link garageUsdPerTbMonth},
 * from the cluster's live layout.
 */
export const DEFAULT_GARAGE_USD_PER_TB = 22.0;

/** Years the hardware is expected to serve, when the operator has not set one. */
export const DEFAULT_HARDWARE_LIFESPAN_YEARS = 5;

/** The operator-configurable half of the model. */
export interface PricingConfig {
  /**
   * One-time capital cost per decimal TB of **raw disk** — what a drive costs.
   * The replication factor is applied on top, from the live layout, so this is
   * a number the operator can read off an invoice.
   */
  garageUsdPerTb: number;
  /** Years that capital is amortized over. */
  hardwareLifespanYears: number;
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = Object.freeze({
  garageUsdPerTb: DEFAULT_GARAGE_USD_PER_TB,
  hardwareLifespanYears: DEFAULT_HARDWARE_LIFESPAN_YEARS,
});

/**
 * Turn a one-time $/TB **raw disk** cost into the $/TB/month rate the
 * comparison runs on, applying the cluster's replication factor.
 *
 * ```
 * usdPerTb * replicationFactor      cost of one USABLE TB of hardware,
 * ────────────────────────────      spread over the lifespan
 *   lifespanYears * 12
 * ```
 *
 * **The replication factor is the term most easily left out, and leaving it out
 * is not a rounding error.** At RF 3 a terabyte of a user's data occupies three
 * terabytes of disk, so omitting it understates the cluster's cost — and
 * overstates the saving — by exactly 3x. It is applied here, from the live
 * layout, rather than folded into the configured price, so an operator
 * configures what they actually paid for a drive and the cluster's own topology
 * supplies the rest. Change the replication factor and this rate follows.
 *
 * At the defaults ($22/raw TB, 5 years, RF 3): $66 of hardware per usable TB,
 * $1.10 per usable TB per month.
 *
 * Returns 0 for a degenerate lifespan or cost rather than dividing by zero;
 * callers treat a 0 rate as "no comparison available", never as "free".
 */
export function garageUsdPerTbMonth(
  usdPerTb: number,
  lifespanYears: number,
  replicationFactor: number
): number {
  if (!(lifespanYears > 0) || !Number.isFinite(usdPerTb) || usdPerTb <= 0) {
    return 0;
  }
  // Clamped like `nodeUsableGbFrom` does: an unreadable replication factor must
  // never make the cluster look cheaper than it is, and 1 is the floor, not 0.
  const rf = Number.isFinite(replicationFactor)
    ? Math.max(replicationFactor, 1)
    : 1;
  return (usdPerTb * rf) / (lifespanYears * 12);
}

/**
 * This cluster as a {@link Rate}.
 *
 * Egress is **zero**, and that is a real difference rather than a thumb on the
 * scale: bandwidth on a self-hosted cluster is not metered per byte. It is not
 * free in the wider sense — transit, power and operator time all cost money —
 * which is why the card's footnote says the hardware figure excludes them.
 */
export function garageRateFor(
  config: PricingConfig,
  replicationFactor: number
): Rate {
  return {
    usdPerTbMonth: garageUsdPerTbMonth(
      config.garageUsdPerTb,
      config.hardwareLifespanYears,
      replicationFactor
    ),
    egressUsdPerTb: 0,
    freeEgressMultiple: 0,
    freeEgressTb: 0,
  };
}

/** What holding `bytes` costs for one month, before egress. */
export function monthlyStorageUsd(bytes: number, rate: Rate): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  if (!Number.isFinite(rate.usdPerTbMonth) || rate.usdPerTbMonth <= 0) return 0;
  return bytesToTb(bytes) * rate.usdPerTbMonth;
}

/**
 * What reading back {@link EGRESS_FRACTION_PER_MONTH} of `bytes` costs for one
 * month, after whichever free allowance the provider gives.
 *
 * The two allowance shapes are both real and are not interchangeable: S3 gives
 * a flat 100 GB a month, while B2 gives a multiple of what you store. Modelling
 * only the flat kind would charge B2 for egress it does not charge for.
 */
export function monthlyEgressUsd(bytes: number, rate: Rate): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  if (!Number.isFinite(rate.egressUsdPerTb) || rate.egressUsdPerTb <= 0) {
    return 0;
  }
  const storedTb = bytesToTb(bytes);
  const egressTb = storedTb * EGRESS_FRACTION_PER_MONTH;
  const freeTb = rate.freeEgressTb + storedTb * rate.freeEgressMultiple;
  return Math.max(egressTb - freeTb, 0) * rate.egressUsdPerTb;
}

/** Storage plus egress, for one month. */
export function monthlyTotalUsd(bytes: number, rate: Rate): number {
  return monthlyStorageUsd(bytes, rate) + monthlyEgressUsd(bytes, rate);
}

/** Storage plus egress, for a year. Twelve months, not 365 days. */
export function annualTotalUsd(bytes: number, rate: Rate): number {
  return monthlyTotalUsd(bytes, rate) * 12;
}

/** One priced row of the comparison. */
export interface ProviderCost {
  key: string;
  label: string;
  note: string;
  /** Storage rate, USD per decimal TB per month — what the card displays. */
  usdPerTbMonth: number;
  monthlyUsd: number;
  annualUsd: number;
  /** Whether this row's total includes a non-zero egress charge. */
  chargesEgress: boolean;
  /**
   * Total cost over the hardware lifespan — the column that makes the
   * comparison concrete. For **this cluster's own row it equals the hardware
   * purchase price exactly**: a lifespan of amortized capital is the capital.
   * That identity is asserted in the tests, because it is what an operator
   * would check by hand and what breaks first if the amortization is wrong.
   */
  horizonUsd: number;
  /** Annual saving this cluster represents against this row. Never negative. */
  savingsVsGarageAnnualUsd: number;
  /**
   * How many times dearer this row is than the cluster, by total cost. `null`
   * when the cluster's own total is 0 — an unconfigured cluster makes the ratio
   * meaningless, and `Infinity` would render as "Infinity× cheaper".
   */
  multipleOfGarage: number | null;
  /** True for the row describing this cluster. */
  isGarage: boolean;
}

/**
 * Price one footprint against every reference rate and against this cluster.
 *
 * `horizonYears` is the window the last column totals — the caller passes the
 * configured hardware lifespan, so the cluster's own row in that column comes
 * out as exactly what the disks cost.
 *
 * Ordered most expensive first, so the saving reads top-to-bottom and the
 * cluster's row lands last as the punchline. `bytes` of 0 yields all-zero rows
 * rather than an empty list — a new account with nothing claimed should still
 * see what the comparison *is*.
 */
export function buildCostComparison(
  bytes: number,
  garageRate: Rate,
  horizonYears: number = DEFAULT_HARDWARE_LIFESPAN_YEARS
): ProviderCost[] {
  const years = Number.isFinite(horizonYears) ? Math.max(horizonYears, 0) : 0;
  const garageAnnual = annualTotalUsd(bytes, garageRate);

  const row = (
    key: string,
    label: string,
    note: string,
    rate: Rate,
    isGarage: boolean
  ): ProviderCost => {
    const monthlyUsd = monthlyTotalUsd(bytes, rate);
    const annualUsd = monthlyUsd * 12;
    return {
      key,
      label,
      note,
      usdPerTbMonth: rate.usdPerTbMonth,
      monthlyUsd,
      annualUsd,
      horizonUsd: annualUsd * years,
      chargesEgress: monthlyEgressUsd(bytes, rate) > 0,
      savingsVsGarageAnnualUsd: Math.max(annualUsd - garageAnnual, 0),
      multipleOfGarage: garageAnnual > 0 ? annualUsd / garageAnnual : null,
      isGarage,
    };
  };

  const rows = REFERENCE_RATES.map((r) =>
    row(r.key, r.label, r.note, r, false)
  );
  rows.push(
    row(
      'garage',
      'This cluster',
      'Hardware at the configured cost per raw TB, multiplied by the replication factor and spread over the hardware lifespan. Bandwidth is not metered per byte here; power, network and operator time are excluded.',
      garageRate,
      true
    )
  );
  return rows.sort((a, b) => b.annualUsd - a.annualUsd);
}

/**
 * Cluster-wide capacity, in bytes, that the layout can actually back.
 *
 * Sums each node's raw declared capacity divided by the replication factor —
 * the quantity `nodeUsableGbFrom` calls "logical GB a node can back". That
 * division is what makes the comparison honest: a cloud provider's price
 * already includes their own replication, so pricing raw declared capacity
 * would overstate the cluster's cloud-equivalent value by the replication
 * factor (3x on a typical layout).
 *
 * Nodes declaring no capacity (gateways) contribute nothing rather than
 * counting as free members. Kept here, in bytes, rather than reusing
 * `nodeUsableGbFrom` directly at the call site, so no GiB figure has to cross
 * into the pricing path at all.
 */
export function clusterUsableBytes(
  nodes: readonly { capacity: number | null }[],
  replicationFactor: number
): number {
  const rf = Math.max(replicationFactor, 1);
  return nodes.reduce((sum, n) => {
    const capacity = n.capacity;
    if (!capacity || capacity <= 0) return sum;
    return sum + capacity / rf;
  }, 0);
}
