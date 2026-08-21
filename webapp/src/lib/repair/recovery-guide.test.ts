import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GARAGE_RECOVERING_DOC,
  RECOVERY_GUIDE,
  guideOutcome,
  guideQuestion,
} from './recovery-guide';

/**
 * The guide is static content, so the tests are structural: every path leads
 * somewhere, every in-app link lands on a page that exists, and every external
 * link goes to Garage's own docs and nowhere else.
 *
 * The link check is the one that earns its keep. A recovery guide pointing at a
 * route that was renamed is worse than no guide, and nothing else in the build
 * would notice — `next build` does not verify `<Link href>`. Precedent:
 * `lib/cluster/layout-sim-boundary.test.ts`.
 */

const APP = path.resolve(import.meta.dirname, '../../app');

/** Every node id reachable from the root, by breadth-first search. */
function reachable(): { questions: Set<string>; outcomes: Set<string> } {
  const questions = new Set<string>();
  const outcomes = new Set<string>();
  const queue = [RECOVERY_GUIDE.rootId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const question = guideQuestion(id);
    if (question) {
      // A cycle would loop for ever without this; the assertion below is what
      // says the graph is a tree.
      if (questions.has(id)) continue;
      questions.add(id);
      for (const option of question.options) queue.push(option.next);
      continue;
    }
    if (guideOutcome(id)) outcomes.add(id);
  }
  return { questions, outcomes };
}

describe('RECOVERY_GUIDE', () => {
  it('resolves every option to a real question or outcome', () => {
    const dangling: string[] = [];
    for (const question of RECOVERY_GUIDE.questions) {
      for (const option of question.options) {
        if (!guideQuestion(option.next) && !guideOutcome(option.next)) {
          dangling.push(`${question.id}/${option.id} → ${option.next}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  it('reaches all four outcomes from the root, and nothing else', () => {
    const { outcomes } = reachable();
    expect(outcomes.size).toBe(4);
    expect(outcomes.size).toBe(RECOVERY_GUIDE.outcomes.length);
  });

  it('has no cycles: no question is its own ancestor', () => {
    const seen = new Set<string>();
    const walk = (id: string, ancestors: string[]) => {
      const question = guideQuestion(id);
      if (!question) return;
      expect(ancestors).not.toContain(id);
      seen.add(id);
      for (const option of question.options) {
        walk(option.next, [...ancestors, id]);
      }
    };
    walk(RECOVERY_GUIDE.rootId, []);
    expect(seen.size).toBe(RECOVERY_GUIDE.questions.length);
  });

  it('links only to app routes that exist on disk', () => {
    const missing: string[] = [];
    for (const outcome of RECOVERY_GUIDE.outcomes) {
      for (const link of outcome.links) {
        if (link.kind !== 'internal') continue;
        const page = path.join(APP, link.href, 'page.tsx');
        if (!existsSync(page)) missing.push(`${outcome.id} → ${link.href}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('sends every external link to Garage’s own documentation', () => {
    for (const outcome of RECOVERY_GUIDE.outcomes) {
      for (const link of outcome.links) {
        if (link.kind !== 'external') continue;
        expect(link.href.startsWith('https://garagehq.deuxfleurs.fr/')).toBe(
          true
        );
      }
    }
    expect(GARAGE_RECOVERING_DOC).toContain('garagehq.deuxfleurs.fr');
  });

  it('says out loud where the app stops', () => {
    // At least one leaf has to hand over to the CLI, or the guide is claiming
    // garage-ware can do everything — which it cannot and must not.
    const handedOver = RECOVERY_GUIDE.outcomes.filter((o) => !o.handledByApp);
    expect(handedOver.length).toBeGreaterThan(0);
    for (const outcome of handedOver) {
      expect(outcome.links.some((l) => l.kind === 'external')).toBe(true);
    }
  });

  it('never suggests an apply without the version it produces', () => {
    // Naming the version is what makes a second, accidental apply fail rather
    // than bump the layout again.
    for (const outcome of RECOVERY_GUIDE.outcomes) {
      for (const command of outcome.commands ?? []) {
        if (command.includes('garage layout apply')) {
          expect(command).toContain('--version');
        }
      }
    }
  });

  it('gives every outcome a title and a body', () => {
    for (const outcome of RECOVERY_GUIDE.outcomes) {
      expect(outcome.title.length).toBeGreaterThan(0);
      expect(outcome.body.length).toBeGreaterThan(0);
      expect(outcome.links.length).toBeGreaterThan(0);
    }
  });
});
