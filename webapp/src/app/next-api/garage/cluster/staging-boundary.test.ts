import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The boundary guard: **garage-ware stages layout changes; it never applies
 * them.**
 *
 * `UpdateClusterLayout` writes into Garage's pending area and moves not one
 * byte of data. `ApplyClusterLayout` commits that area — hours of real data
 * movement, no undo. `RevertClusterLayout` is not the undo either: it clears
 * staging by incrementing the layout version. `ClusterLayoutSkipDeadNodes`
 * forces update trackers past nodes that are not answering, which is a decision
 * about consistency that belongs to whoever can see the machines.
 *
 * So the app calls exactly one of the six layout endpoints that mutate or
 * compute, and the worst a compromised or buggy garage-ware can do to a layout
 * is leave junk in the staging area for an admin to clear with one
 * `garage layout revert`.
 *
 * `PreviewClusterLayoutChanges` is on the list for a different reason: it is
 * read-only, but it only previews changes that are **already staged**, so
 * reaching for it would mean staging something to find out what it would do.
 * The planner computes that locally instead (`lib/cluster/layout-sim.ts`).
 *
 * Deliberately blunt and file-agnostic, in the spirit of
 * `node-id-boundary.test.ts`: the next handler somebody adds fails this without
 * anyone having to remember the rule.
 */

const SRC = path.resolve(import.meta.dirname, '../../../..');

/** Every directory from which a Garage call could be made. */
const SCANNED_DIRS = ['lib/garage', 'app/next-api'];

const FORBIDDEN = [
  'ApplyClusterLayout',
  'RevertClusterLayout',
  'ClusterLayoutSkipDeadNodes',
  'PreviewClusterLayoutChanges',
];

/** This file names all four, and is the one place that may. */
const SELF = 'app/next-api/garage/cluster/staging-boundary.test.ts';

/**
 * Comments are stripped before matching. The rule is about what the app
 * *calls*, and the docblocks that explain why these four are never called have
 * to be free to name them — a guard that forbids writing down its own reason is
 * a guard that gets deleted. Only whole-line comments and block comments go:
 * anything sharing a line with code stays, so a call cannot hide behind one.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

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

describe('layout staging boundary', () => {
  it('scans directories that actually exist', () => {
    // A typo'd path would make the assertion below vacuously true.
    for (const dir of SCANNED_DIRS) {
      expect(sourceFiles(dir).length).toBeGreaterThan(0);
    }
  });

  it('mentions no apply, revert, skip-dead-nodes or preview endpoint', () => {
    const offenders: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of sourceFiles(dir)) {
        if (file === SELF) continue;
        const source = withoutComments(
          readFileSync(path.join(SRC, file), 'utf8')
        );
        for (const endpoint of FORBIDDEN) {
          if (source.includes(endpoint)) offenders.push(`${file}: ${endpoint}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('calls UpdateClusterLayout from exactly one place', () => {
    // Not a style rule: the one wrapper is where "never send `parameters`" and
    // "an assign carries all three fields" are stated and enforced.
    const callers: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of sourceFiles(dir)) {
        if (file === SELF) continue;
        const source = readFileSync(path.join(SRC, file), 'utf8');
        if (source.includes('/v2/UpdateClusterLayout')) callers.push(file);
      }
    }
    expect(callers).toEqual(['lib/garage/cluster.ts']);
  });
});
