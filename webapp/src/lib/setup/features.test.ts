import { describe, expect, it } from 'vitest';
import { parseFeatureFlag } from './features';

describe('parseFeatureFlag', () => {
  it('enables only on an explicit true or 1', () => {
    expect(parseFeatureFlag('true')).toBe(true);
    expect(parseFeatureFlag('1')).toBe(true);
    expect(parseFeatureFlag(' TRUE ')).toBe(true);
    expect(parseFeatureFlag('True')).toBe(true);
  });

  it('fails closed on everything else', () => {
    expect(parseFeatureFlag('yes')).toBe(false);
    expect(parseFeatureFlag('on')).toBe(false);
    expect(parseFeatureFlag('enabled')).toBe(false);
    expect(parseFeatureFlag('false')).toBe(false);
    expect(parseFeatureFlag('0')).toBe(false);
    expect(parseFeatureFlag('')).toBe(false);
    expect(parseFeatureFlag(undefined)).toBe(false);
    expect(parseFeatureFlag(null)).toBe(false);
  });
});
