/**
 * Shape of the deployment self-check rendered at /admin/status.
 *
 * Kept separate from the route so the check ids are a stable vocabulary the
 * troubleshooting docs can key off, and so nothing about rendering leaks into
 * the collection of the facts.
 *
 * Deliberately NOT `server-only` — like `units.ts`, `ledger-math.ts` and
 * `node-label.ts`. The route collects these facts on the server and both
 * `/admin/status` and `/setup` render them in the browser, so the types and the
 * copy-for-support formatter have to be reachable from both sides. A second
 * hand-rolled copy in a component is exactly how those two would come to
 * disagree about what a check said.
 */
export type CheckState = 'ok' | 'warn' | 'fail' | 'unknown';

export interface Check {
  /** Stable identifier — referenced by docker/README.md's troubleshooting table. */
  id: string;
  label: string;
  state: CheckState;
  /** What is true right now. */
  detail: string;
  /** What to do about it, when there is something to do. */
  hint?: string;
}

export interface Diagnostics {
  generatedAt: string;
  /** Worst state across all checks, for a one-glance summary. */
  overall: CheckState;
  checks: Check[];
}

const SEVERITY: Record<CheckState, number> = {
  ok: 0,
  unknown: 1,
  warn: 2,
  fail: 3,
};

export function worstState(checks: Check[]): CheckState {
  return checks.reduce<CheckState>(
    (worst, c) => (SEVERITY[c.state] > SEVERITY[worst] ? c.state : worst),
    'ok'
  );
}

/**
 * Does this deployment look like it has no Garage cluster at all?
 *
 * Keyed on `garage-admin-api === 'fail'` and nothing else. That state is
 * emitted by exactly the two branches this is about: the env vars are unset, or
 * a live health call threw. Two neighbouring states are deliberately excluded:
 *
 * - `'warn'` on the same check means the cluster **answered** and is merely not
 *   healthy. Garage is installed and talking; "install Garage first" would be a
 *   lie.
 * - `garage-layout: 'warn'` means reachable but no layout applied. That check
 *   already carries the exact fix (`garage layout assign` / `apply`), and
 *   showing an installation quickstart to someone with a running cluster is how
 *   an operator learns to ignore the page — the same failure mode documented
 *   for `app-public-url`.
 *
 * An absent check is `false`: never assert "you have no cluster" from missing
 * evidence.
 */
export function needsClusterSetup(checks: Check[]): boolean {
  return checks.some((c) => c.id === 'garage-admin-api' && c.state === 'fail');
}

/**
 * Render diagnostics as plain text for the "Copy diagnostics" button.
 *
 * Everything here is already redacted at collection time — no check ever puts a
 * secret in `detail` — so this is a pure formatting step. Keeping it that way
 * is the point: if a value is unsafe to paste into a support thread, it must
 * not be in the payload either.
 */
export function formatDiagnostics(d: Diagnostics): string {
  const lines = [
    `garage-ware diagnostics — ${d.generatedAt}`,
    `overall: ${d.overall}`,
    '',
  ];
  for (const c of d.checks) {
    lines.push(`[${c.state.toUpperCase().padEnd(7)}] ${c.label}`);
    lines.push(`          ${c.detail}`);
    if (c.hint) lines.push(`          -> ${c.hint}`);
  }
  return lines.join('\n');
}
