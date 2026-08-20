import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The boundary guard: **nothing in the storage-accounting path may import the
 * layout simulator.**
 *
 * `layout-sim.ts` computes each node's *usable* capacity the way Garage does —
 * `storedPartitions × partitionSize` — which is strictly more accurate than the
 * `capacity / replicationFactor` the claim ledger is built on, and routinely
 * lower. That is exactly what makes it dangerous: the per-node claim invariant
 * is **defined** as `sum(claim.quota_gb on node) ≤ capacity / replicationFactor`
 * and enforced by `assertClaimDeltaAllowed`. Swapping in the better number
 * would revalue every node's ceiling downward and could retroactively
 * invalidate claims that were legitimate when they were granted. Changing that
 * denominator is a storage-accounting decision, not a planner one.
 *
 * The module's own conventions — bytes only, no `gb` in any identifier, none of
 * `units.ts`'s `gb*` helpers — make such a crossing *visible*. Branding the
 * type would not help: `number & { __brand }` is still assignable to `number`,
 * so it would flow into `nodeUsableGbFrom(x: number)` freely. So the guard is
 * structural instead, and sibling to `node-id-boundary.test.ts`: it fails for
 * the next person without them having to remember the rule.
 */

const SRC = path.resolve(import.meta.dirname, '../..');

/** Directories whose contents decide, or execute, a storage-accounting change. */
const FORBIDDEN_DIRS = [
  'lib/storage',
  'app/next-api/garage/claims',
  'app/next-api/garage/storage-balances',
  'app/next-api/garage/storage-summary',
  'app/next-api/garage/transfers',
  'app/next-api/garage/invites',
];

const IMPORT_PATTERN = /from\s+['"][^'"]*cluster\/layout-sim['"]/;

function sourceFiles(dir: string): string[] {
  const absolute = path.join(SRC, dir);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(absolute, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(path.join(dir, entry)));
    } else if (/\.tsx?$/.test(entry)) {
      files.push(path.join(dir, entry));
    }
  }
  return files;
}

describe('layout-sim import boundary', () => {
  it('covers directories that actually exist', () => {
    // A typo'd path would make every assertion below vacuously true.
    for (const dir of FORBIDDEN_DIRS) {
      expect(sourceFiles(dir).length).toBeGreaterThan(0);
    }
  });

  it('is imported by nothing in the storage-accounting path', () => {
    const offenders: string[] = [];
    for (const dir of FORBIDDEN_DIRS) {
      for (const file of sourceFiles(dir)) {
        const source = readFileSync(path.join(SRC, file), 'utf8');
        if (IMPORT_PATTERN.test(source)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports nothing that would drag a ledger helper in with it', () => {
    // The other direction: `layout-sim.ts` must stay free of `lib/storage/`
    // entirely, so a GB-denominated helper cannot be reached from it by
    // autocomplete.
    const source = readFileSync(
      path.join(SRC, 'lib/cluster/layout-sim.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/from\s+['"][^'"]*lib\/storage/);
    // And no `gb`-named identifier, so a value that crosses into the ledger is
    // visible at the call site rather than merely type-compatible.
    expect(source.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\bgb[A-Z_]/i);
  });
});
