import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GARAGE_USD_PER_TB,
  DEFAULT_HARDWARE_LIFESPAN_YEARS,
  EGRESS_FRACTION_PER_MONTH,
  HEADLINE_RATE,
  REFERENCE_RATES,
  annualTotalUsd,
  buildCostComparison,
  clusterUsableBytes,
  garageRateFor,
  garageUsdPerTbMonth,
  monthlyEgressUsd,
  monthlyStorageUsd,
  monthlyTotalUsd,
} from './rates';
import { TEBIBYTE, TERABYTE } from '@/lib/storage/units';

// The browser-safe half: the operator's $/TB and the cluster's replication
// factor are injected, never read from an environment or a layout, so there is
// nothing to stub here.

const s3 = REFERENCE_RATES.find((r) => r.key === 's3')!;
const b2 = REFERENCE_RATES.find((r) => r.key === 'backblaze')!;
const garage = garageRateFor(
  { garageUsdPerTb: 22, hardwareLifespanYears: 5 },
  3
);

describe('published reference rates', () => {
  it('carries each provider’s actual list price, per decimal TB', () => {
    // Every row names a real company, so every figure has to be that company's
    // published rate. Checked against their own pricing pages, August 2026.
    expect(s3.usdPerTbMonth).toBe(23); // $0.023/GB, first 50 TB, us-east-1
    expect(s3.egressUsdPerTb).toBe(90); // $0.09/GB to the internet
    expect(s3.freeEgressTb).toBe(0.1); // 100 GB/month
    expect(b2.usdPerTbMonth).toBe(6.95);
    expect(b2.egressUsdPerTb).toBe(10); // $0.01/GB
    expect(b2.freeEgressMultiple).toBe(3); // free up to 3x stored
  });

  it('brackets the market with two providers, not more', () => {
    // One premium, one budget. A second budget row said nothing the first did.
    expect(REFERENCE_RATES).toHaveLength(2);
    expect(REFERENCE_RATES.map((r) => r.key)).toEqual(['s3', 'backblaze']);
  });

  it('quotes S3 as the headline, the dearest of the two', () => {
    expect(HEADLINE_RATE.key).toBe('s3');
    for (const r of REFERENCE_RATES) {
      expect(HEADLINE_RATE.usdPerTbMonth).toBeGreaterThanOrEqual(
        r.usdPerTbMonth
      );
    }
  });
});

describe('garageUsdPerTbMonth (amortization × replication)', () => {
  it('multiplies the raw disk price by the replication factor', () => {
    // $22/raw TB at RF 3 is $66 of hardware per usable TB, over 60 months.
    expect(garageUsdPerTbMonth(22, 5, 3)).toBeCloseTo(66 / 60, 10);
    expect(garageUsdPerTbMonth(22, 5, 3)).toBeCloseTo(1.1, 10);
    expect(garageUsdPerTbMonth(22, 5, 3)).toBeCloseTo(
      garageUsdPerTbMonth(22, 5, 1) * 3,
      10
    );
  });

  it('spreads the capital over the lifespan in months', () => {
    expect(garageUsdPerTbMonth(22, 5, 1)).toBeCloseTo(22 / 60, 12);
    expect(garageUsdPerTbMonth(22, 1, 3)).toBeCloseTo(
      garageUsdPerTbMonth(22, 5, 3) * 5,
      12
    );
  });

  it('clamps a missing or sub-1 replication factor to 1', () => {
    // An unreadable RF must never make the cluster look cheaper than it is.
    const one = garageUsdPerTbMonth(22, 5, 1);
    expect(garageUsdPerTbMonth(22, 5, 0)).toBeCloseTo(one, 12);
    expect(garageUsdPerTbMonth(22, 5, -3)).toBeCloseTo(one, 12);
    expect(garageUsdPerTbMonth(22, 5, Number.NaN)).toBeCloseTo(one, 12);
  });

  it('returns 0 rather than dividing by a degenerate lifespan or cost', () => {
    expect(garageUsdPerTbMonth(22, 0, 3)).toBe(0);
    expect(garageUsdPerTbMonth(22, -5, 3)).toBe(0);
    expect(garageUsdPerTbMonth(0, 5, 3)).toBe(0);
    expect(garageUsdPerTbMonth(-1, 5, 3)).toBe(0);
  });

  it('stays well below every published rate at the defaults', () => {
    const rate = garageUsdPerTbMonth(
      DEFAULT_GARAGE_USD_PER_TB,
      DEFAULT_HARDWARE_LIFESPAN_YEARS,
      3
    );
    for (const r of REFERENCE_RATES) {
      expect(r.usdPerTbMonth).toBeGreaterThan(rate);
    }
  });

  it('reports the cluster as metering no egress', () => {
    expect(garage.egressUsdPerTb).toBe(0);
    expect(monthlyEgressUsd(36 * TERABYTE, garage)).toBe(0);
  });
});

describe('monthlyStorageUsd (the TiB/TB boundary)', () => {
  it('prices one decimal TB at exactly the quoted rate', () => {
    expect(monthlyStorageUsd(TERABYTE, s3)).toBe(23);
    expect(monthlyStorageUsd(TERABYTE, b2)).toBe(6.95);
  });

  it('prices one TiB 10% higher — rates are per decimal TB, not per TiB', () => {
    // Pins the decimal-TB decision. If someone switches the module to binary to
    // "match AWS billing", this fails loudly rather than silently restating
    // every dollar figure on the dashboard.
    expect(
      monthlyStorageUsd(TEBIBYTE, s3) / monthlyStorageUsd(TERABYTE, s3)
    ).toBeCloseTo(1.0995, 4);
  });

  it('is zero for an empty, invalid or unpriced footprint', () => {
    expect(monthlyStorageUsd(0, s3)).toBe(0);
    expect(monthlyStorageUsd(-1, s3)).toBe(0);
    expect(monthlyStorageUsd(Number.NaN, s3)).toBe(0);
    expect(monthlyStorageUsd(TERABYTE, garage)).toBeGreaterThan(0);
  });
});

describe('monthlyEgressUsd (one twelfth read back each month)', () => {
  it('assumes the footprint is read back once a year', () => {
    expect(EGRESS_FRACTION_PER_MONTH).toBeCloseTo(1 / 12, 12);
  });

  it('charges S3 for the download beyond its flat 100 GB allowance', () => {
    // 36 TB claim -> 3 TB/month egress, less 0.1 TB free, at $90/TB.
    expect(monthlyEgressUsd(36 * TERABYTE, s3)).toBeCloseTo((3 - 0.1) * 90, 6);
    expect(monthlyEgressUsd(36 * TERABYTE, s3)).toBeCloseTo(261, 6);
  });

  it('charges Backblaze nothing — 1/12 is well inside its 3x allowance', () => {
    // Modelling only a flat allowance would wrongly bill B2 for this.
    expect(monthlyEgressUsd(36 * TERABYTE, b2)).toBe(0);
    expect(monthlyEgressUsd(500 * TERABYTE, b2)).toBe(0);
  });

  it('would charge Backblaze once egress exceeds three times what is stored', () => {
    // Guards the multiple actually being applied, not just floored to zero.
    const heavy = { ...b2, freeEgressMultiple: 0 };
    expect(monthlyEgressUsd(36 * TERABYTE, heavy)).toBeCloseTo(3 * 10, 6);
  });

  it('is zero for an empty footprint or an unmetered provider', () => {
    expect(monthlyEgressUsd(0, s3)).toBe(0);
    expect(monthlyEgressUsd(36 * TERABYTE, garage)).toBe(0);
  });
});

describe('annualTotalUsd', () => {
  it('is twelve months of storage plus egress, not 365 days', () => {
    expect(annualTotalUsd(36 * TERABYTE, s3)).toBeCloseTo(
      monthlyTotalUsd(36 * TERABYTE, s3) * 12,
      6
    );
  });
});

describe('buildCostComparison — a 36 TB claim at RF 3', () => {
  const CLAIM = 36 * TERABYTE;
  const rows = buildCostComparison(CLAIM, garage);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

  it('prices S3 at $1,089/mo — $828 of storage plus $261 of egress', () => {
    expect(byKey.s3.monthlyUsd).toBeCloseTo(828 + 261, 6);
    expect(byKey.s3.annualUsd).toBeCloseTo(13068, 6);
    expect(byKey.s3.chargesEgress).toBe(true);
  });

  it('prices Backblaze at $250.20/mo, with egress free at this volume', () => {
    expect(byKey.backblaze.monthlyUsd).toBeCloseTo(36 * 6.95, 6);
    expect(byKey.backblaze.annualUsd).toBeCloseTo(3002.4, 6);
    expect(byKey.backblaze.chargesEgress).toBe(false);
  });

  it('prices this cluster at $475.20/yr — 108 raw TB × $22, over 5 years', () => {
    // The cross-check an operator would do by hand: 36 usable TB at RF 3 is
    // 108 TB of disk; 108 × $22 = $2,376 of capital; over 5 years that is
    // $475.20 a year.
    expect(byKey.garage.monthlyUsd).toBeCloseTo(36 * 1.1, 6);
    expect(byKey.garage.annualUsd).toBeCloseTo(475.2, 6);
    expect(byKey.garage.annualUsd * 5).toBeCloseTo(36 * 3 * 22, 6);
    expect(byKey.garage.chargesEgress).toBe(false);
  });

  it('reports the headline annual saving and multiple against S3', () => {
    expect(byKey.s3.savingsVsGarageAnnualUsd).toBeCloseTo(13068 - 475.2, 6);
    expect(byKey.s3.multipleOfGarage).toBeCloseTo(27.5, 1);
  });

  it('orders rows most expensive first, cluster last', () => {
    expect(rows.map((r) => r.key)).toEqual(['s3', 'backblaze', 'garage']);
    expect(rows[rows.length - 1].isGarage).toBe(true);
  });

  it('totals each provider over the horizon', () => {
    const five = buildCostComparison(CLAIM, garage, 5);
    const byK = Object.fromEntries(five.map((r) => [r.key, r]));
    expect(byK.s3.horizonUsd).toBeCloseTo(13068 * 5, 6);
    expect(byK.backblaze.horizonUsd).toBeCloseTo(3002.4 * 5, 6);
  });

  it("makes the cluster's horizon total equal the disks it bought", () => {
    // The identity that makes the last column self-checking: a lifespan of
    // amortized capital IS the capital. 36 usable TB at RF 3 is 108 raw TB;
    // 108 × $22 = $2,376. If the amortization is ever wrong, this breaks.
    const five = buildCostComparison(CLAIM, garage, 5);
    const here = five.find((r) => r.isGarage)!;
    expect(here.horizonUsd).toBeCloseTo(36 * 3 * 22, 6);
    expect(here.horizonUsd).toBeCloseTo(2376, 6);
  });

  it('holds that identity for any lifespan and replication factor', () => {
    for (const years of [1, 3, 7]) {
      for (const rf of [1, 2, 3, 5]) {
        const rate = garageRateFor(
          { garageUsdPerTb: 22, hardwareLifespanYears: years },
          rf
        );
        const here = buildCostComparison(CLAIM, rate, years).find(
          (r) => r.isGarage
        )!;
        expect(here.horizonUsd).toBeCloseTo(36 * rf * 22, 6);
      }
    }
  });

  it('treats a degenerate horizon as zero rather than NaN', () => {
    for (const years of [0, -5, Number.NaN]) {
      const rows = buildCostComparison(CLAIM, garage, years);
      for (const r of rows) expect(r.horizonUsd).toBe(0);
    }
  });

  it('exposes the storage rate the card displays, not the blended total', () => {
    // The card shows "$23.00/TB/mo" beside a total that includes egress; the
    // two must not be conflated into one derived number.
    expect(byKey.s3.usdPerTbMonth).toBe(23);
    expect(byKey.garage.usdPerTbMonth).toBeCloseTo(1.1, 10);
  });
});

describe('buildCostComparison — degenerate inputs', () => {
  it('returns all-zero rows for an empty claim without dividing by zero', () => {
    const rows = buildCostComparison(0, garage);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.monthlyUsd).toBe(0);
      expect(r.annualUsd).toBe(0);
      expect(r.savingsVsGarageAnnualUsd).toBe(0);
      // Still shows what the comparison IS, via the rate.
      expect(Number.isFinite(r.usdPerTbMonth)).toBe(true);
    }
  });

  it('reports a null multiple, never Infinity, when the cluster costs 0', () => {
    const free = garageRateFor(
      { garageUsdPerTb: 0, hardwareLifespanYears: 5 },
      3
    );
    const rows = buildCostComparison(36 * TERABYTE, free);
    for (const r of rows) expect(r.multipleOfGarage).toBeNull();
    expect(rows.every((r) => Number.isFinite(r.annualUsd))).toBe(true);
  });

  it('never reports a negative saving', () => {
    const dear = garageRateFor(
      { garageUsdPerTb: 10000, hardwareLifespanYears: 1 },
      3
    );
    const rows = buildCostComparison(36 * TERABYTE, dear);
    for (const r of rows)
      expect(r.savingsVsGarageAnnualUsd).toBeGreaterThanOrEqual(0);
  });
});

describe('the savings multiple barely moves with scale', () => {
  it('converges upward as S3’s flat allowance stops mattering', () => {
    // Storage and egress both scale with the footprint, so the ratio would be
    // exactly scale-invariant were it not for S3's flat 100 GB/month egress
    // allowance. That allowance is proportionally larger for a small claim, so
    // a small claim gets a slightly *better* deal from S3 — and the multiple
    // rises towards a limit as the claim grows. Asserting the direction
    // catches an allowance applied as a multiple by mistake, which would push
    // it the other way.
    const multiple = (tb: number) =>
      buildCostComparison(tb * TERABYTE, garage)[0].multipleOfGarage!;
    expect(multiple(500)).toBeGreaterThan(multiple(100));
    // ...but only just: within 1% across a 5x range.
    expect(multiple(500) / multiple(100) - 1).toBeLessThan(0.01);
    // And it never runs away — the limit is storage+egress over hardware.
    expect(multiple(100_000)).toBeLessThan((23 + 90 / 12) / 1.1);
  });
});

describe('clusterUsableBytes', () => {
  it('divides declared capacity by the replication factor', () => {
    const nodes = [{ capacity: 3 * TERABYTE }, { capacity: 3 * TERABYTE }];
    expect(clusterUsableBytes(nodes, 3)).toBeCloseTo(2 * TERABYTE, 6);
  });

  it('skips gateway nodes, which declare no capacity', () => {
    const nodes = [{ capacity: 3 * TERABYTE }, { capacity: null }];
    expect(clusterUsableBytes(nodes, 3)).toBeCloseTo(TERABYTE, 6);
  });

  it('treats a replication factor below 1 as 1 rather than inflating capacity', () => {
    expect(clusterUsableBytes([{ capacity: TERABYTE }], 0)).toBeCloseTo(
      TERABYTE,
      6
    );
  });

  it('is empty for an empty layout', () => {
    expect(clusterUsableBytes([], 3)).toBe(0);
  });

  it('agrees with the per-user rate: cluster hardware cost is RF-consistent', () => {
    // Pricing the cluster's USABLE bytes at the RF-inclusive rate must equal
    // pricing its RAW disk at the raw price. If these ever disagree, the
    // replication factor is being applied twice or not at all.
    const nodes = [{ capacity: 30 * TERABYTE }, { capacity: 30 * TERABYTE }];
    const usable = clusterUsableBytes(nodes, 3);
    expect(annualTotalUsd(usable, garage)).toBeCloseTo((60 * 22) / 5, 6);
  });
});
