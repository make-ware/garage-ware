#!/usr/bin/env node
//
// Fail if a git-tracked source file depends on a file git does not track.
//
// CI builds a fresh checkout, so it only ever sees tracked files; a dev machine
// also has generated and runtime state (pocketbase/pb_data/, local scratch
// files) that is gitignored. Anything the build reads from that second set
// works locally and fails in CI — which is exactly how `next build` started
// dying with TS6053 on `pocketbase/pb_hooks/lib/node-metrics.js`, whose
// `/// <reference path="../../pb_data/types.d.ts" />` was pulled into the
// webapp's TS program by a test that imports the module across the workspace
// boundary. The reference had been dangling for as long as CI had existed; it
// only surfaced when something in webapp/ first imported that file.
//
// Two checks, both string-level and both instant (no tsc, no bundler):
//
//   1. Triple-slash `/// <reference path="..." />` targets must be tracked.
//      These are unconditional — tsc errors on a missing one even in a .js
//      file it never type-checks.
//   2. Relative `import`/`require`/`import()` specifiers that resolve to a real
//      file on disk must resolve to a *tracked* one. Deliberately quiet when
//      nothing resolves: that means an alias, a virtual module, or a bundler
//      rule this script has no business second-guessing.
//
// Run via `yarn check:refs`; `yarn precommit` runs it first, since it is the
// cheapest gate in the sequence.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
);

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIR = new RegExp(
  [
    // Vendored bundles: megabytes of machine-written code with no hand-authored
    // dependencies worth checking, and enough incidental string literals to
    // make the import scan noisy.
    '\\.yarn/',
    'node_modules/',
    // Migrations carry the same dangling pb_data reference, but the generator
    // (and PocketBase itself) writes that header, so removing it would just
    // come back with the next generated file — and unlike pb_hooks/, nothing
    // imports a migration, so no TS program ever loads one. If that ever
    // changes, drop the reference from the file the importer pulls in.
    '^pocketbase/pb_migrations/',
  ].join('|')
);

// Anchored to the start of a line, which is the only place TypeScript honours a
// triple-slash directive — and it keeps prose that merely *mentions* one (this
// file's own header, main.pb.js's warning) from tripping the check.
const REFERENCE = /^[^\S\n]*\/\/\/\s*<reference\s+path\s*=\s*["']([^"'\n]+)["']/gm;
const SPECIFIER = [
  /\bfrom\s*["'](\.[^"']*)["']/g,
  /\brequire\(\s*["'](\.[^"']*)["']\s*\)/g,
  /\bimport\(\s*["'](\.[^"']*)["']\s*\)/g,
  /\bimport\s+["'](\.[^"']*)["']/g,
];

/** TS resolution order, trimmed to what this repo can actually produce. */
function candidates(spec) {
  const out = [];
  const js = spec.match(/\.([cm]?)js(x?)$/);
  if (js) {
    const [, prefix, x] = js;
    const stem = spec.slice(0, -(js[0].length));
    out.push(`${stem}.${prefix}ts${x}`, `${stem}.d.${prefix}ts`);
  }
  out.push(spec);
  for (const ext of ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) {
    out.push(spec + ext);
    out.push(path.posix.join(spec, 'index' + ext));
  }
  return out;
}

function isFile(abs) {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

const problems = [];

function record(file, line, specifier, target, why) {
  problems.push({ file, line, specifier, target, why });
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

for (const file of tracked) {
  if (SKIP_DIR.test(file) || !SOURCE_EXT.test(file)) continue;

  const abs = path.join(root, file);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue; // deleted in the working tree; not this script's problem
  }

  const dir = path.posix.dirname(file);

  for (const [match, spec] of text.matchAll(REFERENCE)) {
    const target = path.posix.normalize(path.posix.join(dir, spec));
    if (!tracked.has(target)) {
      record(
        file,
        lineOf(text, text.indexOf(match)),
        spec,
        target,
        isFile(path.join(root, target))
          ? 'exists locally but is not tracked by git'
          : 'does not exist'
      );
    }
  }

  for (const re of SPECIFIER) {
    for (const [match, spec] of text.matchAll(re)) {
      const base = path.posix.normalize(path.posix.join(dir, spec));
      const resolved = candidates(base).find((c) => isFile(path.join(root, c)));
      if (resolved && !tracked.has(resolved)) {
        record(
          file,
          lineOf(text, text.indexOf(match)),
          spec,
          resolved,
          'exists locally but is not tracked by git'
        );
      }
    }
  }
}

if (problems.length === 0) {
  process.exit(0);
}

console.error(
  `\n${problems.length} tracked file dependenc${problems.length === 1 ? 'y' : 'ies'} on untracked path(s):\n`
);
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}`);
  console.error(`    "${p.specifier}" -> ${p.target} (${p.why})`);
}
console.error(
  '\nCI checks out only tracked files, so these resolve locally and fail there.\n' +
    'Commit the target, drop the dependency, or move it behind editor-only\n' +
    'config (see pocketbase/jsconfig.json for how the JSVM typings do it).\n'
);
process.exit(1);
