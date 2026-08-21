import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import RepairsOverviewPage from './page';

/**
 * The overview, as a console rather than a launcher.
 *
 * The assertion that carries the design decision is the last one: **nothing on
 * this page launches a repair.** The overview reads; the tabs act, because each
 * of them explains what its operation costs before it offers a button.
 */

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: mocks.api }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const KEY_A = 'aaaa000000000001';
const KEY_B = 'bbbb000000000002';
const FETCHED_AT = '2026-08-20T12:00:00.000Z';
const NOW = Date.parse(FETCHED_AT);
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const scrub = (lastCompletedAt: string | null) => ({
  workerId: 1,
  workerName: 'block scrub worker',
  state: 'idle',
  throttledSecs: null,
  progress: null,
  tranquility: 6,
  errors: 0,
  consecutiveErrors: 0,
  lastError: null,
  lastCompletedAt,
  resumesAt: null,
  nextScheduledAt: null,
  corruptionsDetected: 0,
  paused: false,
  freeform: [],
  recognised: true,
});

const workersFor = (nodeId: string, lastCompletedAt: string | null) => ({
  nodeId,
  error: null,
  workers: [],
  workerNames: ['block scrub worker'],
  scrub: scrub(lastCompletedAt),
  busyCount: 0,
  erroredCount: 0,
});

/** Route the mocked `api()` by path, since the page fires four fetches. */
function setup(over: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    '/next-api/garage/cluster/nodes': {
      items: [
        {
          id: KEY_A,
          zone: 'dc1',
          tags: ['name:vault-01'],
          isUp: true,
          draining: false,
        },
        { id: KEY_B, zone: 'dc2', tags: [], isUp: true, draining: false },
      ],
      replicationFactor: 3,
      layoutVersion: 12,
    },
    '/next-api/garage/repairs/workers': {
      items: [
        workersFor(KEY_A, daysAgo(3)),
        // 200 days: stale by any reading of "about once a month".
        workersFor(KEY_B, daysAgo(200)),
      ],
      fetchedAt: FETCHED_AT,
    },
    '/next-api/garage/repairs/node-stats': {
      items: [
        {
          nodeId: KEY_A,
          error: null,
          resyncQueueLen: 26_541,
          resyncErrors: 0,
          rcEntries: 10,
        },
        // Reported nothing: must render as "—", never as an empty queue.
        {
          nodeId: KEY_B,
          error: null,
          resyncQueueLen: null,
          resyncErrors: null,
          rcEntries: null,
        },
      ],
      fetchedAt: FETCHED_AT,
    },
    '/next-api/garage/repairs/block-errors': {
      items: [],
      fetchedAt: FETCHED_AT,
      perNodeLimit: 25,
    },
    '/next-api/garage/events': {
      items: [],
      page: 1,
      perPage: 20,
      totalItems: 0,
      totalPages: 0,
    },
    ...over,
  };

  mocks.api.mockImplementation(async (path: string) => {
    const key = Object.keys(responses).find((p) => path.startsWith(p));
    if (!key) throw new Error(`unexpected fetch: ${path}`);
    const value = responses[key];
    if (value instanceof Error) throw value;
    return value;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setup();
});

describe('RepairsOverviewPage', () => {
  it('lays the cards out finding-last: state, nodes, block errors, operations, history', async () => {
    const { container } = render(<RepairsOverviewPage />);
    await screen.findByText('vault-01');

    const titles = [...container.querySelectorAll('[data-slot="card-title"]')]
      .map((el) => el.textContent)
      .filter((t): t is string => Boolean(t));

    expect(titles.slice(0, 3)).toEqual([
      'Cluster worker state',
      'Nodes',
      'Block errors',
    ]);
    // The log goes last, after the three operation cards.
    expect(titles.at(-1)).toBe('Recent repairs');
    expect(titles).toContain('Scrub');
  });

  it('counts nodes whose scrub is overdue', async () => {
    render(<RepairsOverviewPage />);
    const label = await screen.findByText(/with a stale scrub$/);
    expect(label.previousSibling?.textContent).toBe('1');
  });

  it('shows a live resync queue, and “—” for a node that reported none', async () => {
    render(<RepairsOverviewPage />);
    // Twice: the summary tile and the node's row.
    await waitFor(() => expect(screen.getAllByText('26,541')).toHaveLength(2));
    // "Not reported" and "the queue is empty" are opposite conclusions.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText(/blocks queued for resync/)).toBeInTheDocument();
  });

  it('launches nothing: the overview reads, the tabs act', async () => {
    render(<RepairsOverviewPage />);
    await screen.findByText('vault-01');

    for (const label of [
      'Start scrub',
      'Pause scrub',
      'Resume scrub',
      'Cancel scrub',
      'Repair blocks',
      'Rebalance',
    ]) {
      expect(
        screen.queryByRole('button', { name: label })
      ).not.toBeInTheDocument();
    }
  });

  it('still renders the table when the block-errors read is refused', async () => {
    // The day-one path on an install whose admin token predates this release.
    setup({
      '/next-api/garage/repairs/block-errors': new Error(
        'The Garage cluster refused ListBlockErrors. The admin token is probably missing that scope.'
      ),
    });
    render(<RepairsOverviewPage />);

    expect(await screen.findByText('vault-01')).toBeInTheDocument();
    expect(screen.getByText(/refused ListBlockErrors/)).toBeInTheDocument();
  });
});
