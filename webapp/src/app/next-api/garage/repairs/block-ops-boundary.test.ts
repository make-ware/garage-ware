import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The boundary guard: **garage-ware lists errored blocks and asks Garage to
 * fetch them again; it never deletes what references them.**
 *
 * `PurgeBlocks` sits one operation away from `RetryBlockResync` under the same
 * `Block` tag, takes a near-identical request body, and does something
 * categorically different: it removes every object and in-progress multipart
 * upload containing the named blocks, permanently, from the buckets they
 * appear in. That is user data, deleted on a click, with no undo and nothing in
 * this app's model to reconcile afterwards — `Buckets` rows would still exist
 * and the objects behind them would not. It is not a repair; it is a decision
 * to accept data loss, and it belongs to whoever can see the cluster.
 *
 * `GetBlockInfo` is read-only and still forbidden: it enumerates the buckets,
 * object versions and multipart uploads referencing a block, which is a listing
 * of user data that an admin maintenance page has no reason to read. Nothing in
 * the repairs surface needs it, and a wrapper existing "for completeness" is
 * how it would acquire a caller.
 *
 * Deliberately blunt and file-agnostic, in the spirit of
 * `cluster/staging-boundary.test.ts` and `cluster/node-id-boundary.test.ts`:
 * the next wrapper somebody adds fails this without anyone having to remember
 * the rule.
 */

const SRC = path.resolve(import.meta.dirname, '../../../..');

/** Every directory from which a Garage call could be made. */
const SCANNED_DIRS = ['lib/garage', 'app/next-api'];

const FORBIDDEN = ['PurgeBlocks', 'GetBlockInfo'];

/** This file names both, and is the one place that may. */
const SELF = 'app/next-api/garage/repairs/block-ops-boundary.test.ts';

/**
 * Comments are stripped before matching, exactly as the staging guard does it:
 * the rule is about what the app *calls*, and the docblock in
 * `lib/garage/blocks.ts` explaining why these two are never called has to be
 * free to name them. A guard that forbids writing down its own reason is a
 * guard that gets deleted.
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

describe('block operations boundary', () => {
  it('scans directories that actually exist', () => {
    // A typo'd path would make the assertion below vacuously true.
    for (const dir of SCANNED_DIRS) {
      expect(sourceFiles(dir).length).toBeGreaterThan(0);
    }
  });

  it('mentions no purge or block-info endpoint', () => {
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

  it('calls RetryBlockResync from exactly one place', () => {
    // Not a style rule: the one wrapper is where "refuses `*` and `self`" is
    // stated and enforced, and `*` here would re-queue every errored block on
    // every node from a dialog naming one.
    const callers: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of sourceFiles(dir)) {
        // Tests name the endpoint to assert the URL that goes on the wire —
        // that is the guard working, not a second caller.
        if (file === SELF || /\.test\.tsx?$/.test(file)) continue;
        const source = readFileSync(path.join(SRC, file), 'utf8');
        if (source.includes('/v2/RetryBlockResync')) callers.push(file);
      }
    }
    expect(callers).toEqual(['lib/garage/blocks.ts']);
  });
});
