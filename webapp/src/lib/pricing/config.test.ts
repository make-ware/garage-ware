import { afterEach, describe, expect, it } from 'vitest';
import { pricingConfig } from './config';
import { garageRateFor } from './rates';

const COST = 'GARAGE_COST_USD_PER_TB';
const LIFESPAN = 'GARAGE_HARDWARE_LIFESPAN_YEARS';

afterEach(() => {
  delete process.env[COST];
  delete process.env[LIFESPAN];
});

describe('pricingConfig', () => {
  it('falls back to the documented defaults when unset', () => {
    expect(pricingConfig()).toEqual({
      garageUsdPerTb: 22,
      hardwareLifespanYears: 5,
    });
  });

  it('reads a configured hardware cost', () => {
    // The raw disk price, as it appears on an invoice — the replication factor
    // is applied separately, from the live layout.
    process.env[COST] = '35';
    expect(pricingConfig().garageUsdPerTb).toBe(35);
  });

  it('reads a configured lifespan', () => {
    process.env[LIFESPAN] = '3';
    expect(pricingConfig().hardwareLifespanYears).toBe(3);
  });

  it('rejects a zero cost rather than rendering the cluster as free', () => {
    // The case that matters most: $0/TB makes the saving 100% and the multiple
    // infinite — a false claim, and one nobody would think to check.
    process.env[COST] = '0';
    expect(pricingConfig().garageUsdPerTb).toBe(22);
  });

  it('falls back for negative, non-numeric and empty values', () => {
    for (const v of ['-1', 'abc', '', 'NaN']) {
      process.env[COST] = v;
      process.env[LIFESPAN] = v;
      const config = pricingConfig();
      expect(config.garageUsdPerTb).toBe(22);
      expect(config.hardwareLifespanYears).toBe(5);
      // Never NaN — a NaN rate poisons every figure on the card.
      expect(Number.isFinite(garageRateFor(config, 3).usdPerTbMonth)).toBe(
        true
      );
    }
  });

  it('accepts a fractional lifespan', () => {
    process.env[LIFESPAN] = '0.5';
    expect(pricingConfig().hardwareLifespanYears).toBe(0.5);
  });

  it('never produces a non-finite rate for any env value', () => {
    for (const v of ['1e400', '0.0000001', '999999999']) {
      process.env[COST] = v;
      expect(
        Number.isFinite(garageRateFor(pricingConfig(), 3).usdPerTbMonth)
      ).toBe(true);
    }
  });
});
