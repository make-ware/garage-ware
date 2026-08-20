import { describe, expect, it } from 'vitest';
import { needsClusterSetup, type Check } from './diagnostics';

function check(id: string, state: Check['state'], detail = 'x'): Check {
  return { id, label: id, state, detail };
}

describe('needsClusterSetup', () => {
  it('is true when the admin API check failed because nothing is configured', () => {
    expect(
      needsClusterSetup([
        check('pocketbase-superuser', 'ok'),
        check(
          'garage-admin-api',
          'fail',
          'GARAGE_ADMIN_URL and GARAGE_ADMIN_TOKEN not set — this deployment is not connected to a cluster.'
        ),
        check('garage-layout', 'unknown'),
      ])
    ).toBe(true);
  });

  it('is true when the admin API check failed because the cluster is unreachable', () => {
    // Same state, entirely different sentence: the predicate keys on `state`,
    // never on the wording of `detail`.
    expect(
      needsClusterSetup([
        check(
          'garage-admin-api',
          'fail',
          'Connection refused by the Garage admin API (10.0.0.5:3903)'
        ),
      ])
    ).toBe(true);
  });

  it('is false when the admin API is healthy', () => {
    expect(
      needsClusterSetup([
        check('garage-admin-api', 'ok'),
        check('garage-layout', 'ok'),
      ])
    ).toBe(false);
  });

  it('is false when the cluster answered but is not healthy', () => {
    // 'warn' means Garage is installed and talking. Telling that operator to
    // install Garage would be a lie.
    expect(needsClusterSetup([check('garage-admin-api', 'warn')])).toBe(false);
  });

  it('is false when the check is absent', () => {
    // Never assert "you have no cluster" from missing evidence.
    expect(needsClusterSetup([check('pocketbase-superuser', 'fail')])).toBe(
      false
    );
    expect(needsClusterSetup([])).toBe(false);
  });

  it('is false when only the layout warns', () => {
    // Reachable cluster, no layout applied. That check already carries the
    // exact fix; an installation quickstart here is noise.
    expect(
      needsClusterSetup([
        check('garage-admin-api', 'ok'),
        check('garage-layout', 'warn', 'No layout has been applied.'),
      ])
    ).toBe(false);
  });
});
