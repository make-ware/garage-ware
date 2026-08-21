/**
 * Garage's recovering-from-failures procedure, as a decision tree.
 *
 * The mapping from *what went wrong* to *what to do* is in the official doc and
 * nowhere in this app; an operator has had to hold it in their head while
 * looking at a page of buttons. This encodes it — and, just as importantly,
 * encodes where garage-ware stops and the `garage` CLI begins.
 *
 * **Pure and static.** No JSX, no clock, no I/O, no import from `lib/garage/`.
 * Bodies are plain strings so the module stays greppable and testable, and so
 * the page that walks it cannot render a sentence that is not written here.
 * Same family as `lib/cluster/planner-copy.ts` and `staging-copy.ts`.
 *
 * **Two levels, not one.** A root with four options is a menu; the question
 * that actually separates "replace the drive" from "the metadata DB is
 * corrupt" is whether the node still starts, and asking it is the feature.
 */

import {
  APPLY_ONCE_WARNING,
  STAGE_ONLY_NOTICE,
} from '@/lib/cluster/staging-copy';

export const GARAGE_RECOVERING_DOC =
  'https://garagehq.deuxfleurs.fr/documentation/operations/recovering/';

export const GARAGE_LAYOUT_DOC =
  'https://garagehq.deuxfleurs.fr/documentation/operations/layout/';

export interface GuideLink {
  /** `internal` is a route in this app; `external` is Garage's own docs. */
  kind: 'internal' | 'external';
  href: string;
  label: string;
}

export interface GuideOutcome {
  id: string;
  title: string;
  /** One paragraph per entry. */
  body: string[];
  links: GuideLink[];
  /**
   * Whether this app can do the thing, or only point at it. `false` is not a
   * gap — it is the boundary, and the page says so out loud.
   */
  handledByApp: boolean;
  /** Commands the operator runs themselves, on a cluster host. */
  commands?: string[];
}

export interface GuideOption {
  id: string;
  label: string;
  hint?: string;
  /** A question id or an outcome id. */
  next: string;
}

export interface GuideQuestion {
  id: string;
  prompt: string;
  options: GuideOption[];
}

const QUESTIONS: GuideQuestion[] = [
  {
    id: 'q-root',
    prompt: 'What happened?',
    options: [
      {
        id: 'disk',
        label: 'A disk failed. The node itself still runs.',
        hint: 'New drive fitted, or about to be — same machine, same node ID.',
        next: 'drive-replaced',
      },
      {
        id: 'node',
        label: 'A whole node is gone, and its replacement has a new node ID.',
        hint: 'Rebuilt or replaced machine; Garage sees it as a different node.',
        next: 'node-lost-new-id',
      },
      {
        id: 'metadata',
        label: 'The node runs, or tries to, but its metadata looks wrong.',
        hint: 'After an unclean shutdown, a full disk, or a crash loop.',
        next: 'q-meta',
      },
      {
        id: 'quorum',
        label: 'Several nodes are down and writes are failing.',
        hint: 'Fewer nodes reachable than the replication factor needs.',
        next: 'quorum-lost',
      },
    ],
  },
  {
    id: 'q-meta',
    prompt: 'Does Garage start on that node and serve reads?',
    options: [
      {
        id: 'starts',
        label: 'It starts and serves, but some data is missing.',
        next: 'drive-replaced',
      },
      {
        id: 'refuses',
        label: 'It refuses to start, or reports a corrupt metadata database.',
        next: 'meta-corrupted',
      },
    ],
  },
];

const OUTCOMES: GuideOutcome[] = [
  {
    id: 'drive-replaced',
    title: 'Run a block repair on that node',
    body: [
      'The node keeps its metadata — every block reference it should hold is still recorded — so what is missing is the block data itself. A block repair walks those references and re-fetches whatever the node cannot find from its peers.',
      'It runs in the background for hours to days, cannot be paused, and is heavy on both this node and the peers it pulls from. Start it once and let it finish; the resync queue on the repairs overview is how you watch it move. Expect the queue to rise before it falls.',
      'If the node has lost its metadata as well as its data, treat it as a new node instead — go back and pick the second option.',
    ],
    links: [
      {
        kind: 'internal',
        href: '/admin/repairs/blocks',
        label: 'Blocks repair',
      },
      {
        kind: 'external',
        href: GARAGE_RECOVERING_DOC,
        label: 'Garage: recovering from failures',
      },
    ],
    handledByApp: true,
  },
  {
    id: 'node-lost-new-id',
    title: 'Stage the swap, then apply it yourself',
    body: [
      'The replacement machine has a different node ID, so the layout has to be told that the new node takes over the old one’s role. The CLI spells this `garage layout assign --replace`; there is no single admin-API call for it, so this app does the equivalent in one staging operation: a **remove** of the old node key and an **assign** of the new one, staged together.',
      'The replacement must have joined the cluster first — a node Garage has never heard from is not an addressable candidate, and the staging page will not offer it. Connect it, then stage both changes in one go so a single apply commits them.',
      STAGE_ONLY_NOTICE,
      APPLY_ONCE_WARNING,
    ],
    links: [
      {
        kind: 'internal',
        href: '/admin/cluster/staging',
        label: 'Layout staging',
      },
      {
        kind: 'external',
        href: GARAGE_LAYOUT_DOC,
        label: 'Garage: layout operations',
      },
      {
        kind: 'external',
        href: GARAGE_RECOVERING_DOC,
        label: 'Garage: recovering from failures',
      },
    ],
    handledByApp: true,
    commands: ['garage layout show', 'garage layout apply --version <N+1>'],
  },
  {
    id: 'meta-corrupted',
    title: 'This one is not ours — use the CLI',
    body: [
      'garage-ware runs no metadata repairs, and that is true by construction rather than by omission: the six repair types that touch metadata tables — `tables`, `versions`, `multipartUploads`, `blockRefs`, `blockRc` and `aliases` — are not mapped to any action this app offers, so there is no button here that could run one even by mistake.',
      'They are also not the first thing to reach for. A node that will not start usually needs its logs read and its disk checked before anything is repaired, and running a metadata repair on a node whose disk is full or failing makes the situation worse.',
      'Garage’s own guide covers the sequence, including when a metadata database is better restored from a backup than repaired.',
    ],
    links: [
      {
        kind: 'external',
        href: GARAGE_RECOVERING_DOC,
        label: 'Garage: recovering from failures',
      },
    ],
    handledByApp: false,
  },
  {
    id: 'quorum-lost',
    title: 'Get the nodes back first — do not start a repair',
    body: [
      'With fewer nodes reachable than the replication factor requires, writes cannot reach a quorum and no repair can help: a repair works by fetching blocks from peers, and the peers are what is missing.',
      'Explicitly do not launch a scrub, a block repair or a rebalance now. Each of them generates exactly the cross-node traffic a degraded cluster is least able to serve, and none of them will make progress until the nodes return.',
      'Check which nodes are actually reachable, bring back what can be brought back, and only then decide whether anything needs repairing. If a node is gone for good, its replacement is a layout change, not a repair.',
    ],
    links: [
      { kind: 'internal', href: '/admin/status', label: 'Status' },
      {
        kind: 'external',
        href: GARAGE_RECOVERING_DOC,
        label: 'Garage: recovering from failures',
      },
    ],
    handledByApp: false,
  },
];

export const RECOVERY_GUIDE: {
  rootId: string;
  questions: GuideQuestion[];
  outcomes: GuideOutcome[];
} = {
  rootId: 'q-root',
  questions: QUESTIONS,
  outcomes: OUTCOMES,
};

export function guideQuestion(id: string): GuideQuestion | null {
  return RECOVERY_GUIDE.questions.find((q) => q.id === id) ?? null;
}

export function guideOutcome(id: string): GuideOutcome | null {
  return RECOVERY_GUIDE.outcomes.find((o) => o.id === id) ?? null;
}

/**
 * The hedge that goes on every outcome. One string, so it cannot be softened on
 * one branch: this is a map of the official procedure, not a diagnosis of your
 * cluster.
 */
export const GUIDE_HEDGE =
  'This is guidance, not a diagnosis. It maps Garage’s own recovery ' +
  'documentation onto the actions this app offers; it has not looked at your ' +
  'cluster. Read `garage status` and the node’s logs before acting.';
