import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BlockErrorsCard } from './block-errors-card';
import type {
  BlockErrorNode,
  BlockErrorsResponse,
} from '@/app/next-api/garage/repairs/block-errors/route';

vi.mock('@/lib/api-client', () => ({
  api: vi.fn(async () => ({ ok: true, count: 1, logged: true })),
}));

const KEY_A = 'aaaa000000000001';
const KEY_B = 'bbbb000000000002';

const names = new Map<string, string | null>([
  [KEY_A, 'vault-01'],
  [KEY_B, null],
]);

function node(over: Partial<BlockErrorNode> = {}): BlockErrorNode {
  return {
    nodeId: KEY_A,
    error: null,
    totalErrors: 0,
    items: [],
    truncated: false,
    ...over,
  };
}

function data(items: BlockErrorNode[]): BlockErrorsResponse {
  return { items, fetchedAt: '2026-08-20T12:00:00Z', perNodeLimit: 25 };
}

function renderCard(over: Partial<Parameters<typeof BlockErrorsCard>[0]> = {}) {
  return render(
    <BlockErrorsCard
      data={data([node()])}
      error={null}
      loading={false}
      nodeNames={names}
      onRetried={async () => {}}
      {...over}
    />
  );
}

describe('BlockErrorsCard', () => {
  it('says so plainly when there is nothing wrong', () => {
    renderCard();
    expect(screen.getByText('No block errors.')).toBeInTheDocument();
  });

  it('renders a node that did not answer, and never as zero errors', () => {
    // Not knowing is the opposite of a clean bill of health.
    renderCard({
      data: data([node({ nodeId: KEY_B, error: 'node unreachable' })]),
    });

    expect(screen.getByText('node unreachable')).toBeInTheDocument();
    expect(screen.queryByText(/0 errored block/)).not.toBeInTheDocument();
    expect(screen.queryByText('No block errors.')).not.toBeInTheDocument();
  });

  it('shows truncated hashes and the counts beside them', () => {
    renderCard({
      data: data([
        node({
          totalErrors: 1,
          items: [
            {
              hash: 'deadbeefcafef00d',
              refcount: 4,
              errorCount: 9,
              lastTrySecsAgo: 120,
              nextTryInSecs: 300,
            },
          ],
        }),
      ]),
    });

    expect(screen.getByText('deadbeefcafef00d…')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('2m ago')).toBeInTheDocument();
    expect(screen.getByText('in 5m')).toBeInTheDocument();
  });

  it('renders the cap rather than letting a truncated list look complete', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      hash: i.toString(16).padStart(16, '0'),
      refcount: 1,
      errorCount: 1,
      lastTrySecsAgo: i,
      nextTryInSecs: 1,
    }));
    renderCard({
      data: data([node({ totalErrors: 41_233, items, truncated: true })]),
    });

    expect(screen.getByText(/Showing 25 of 41,233/)).toBeInTheDocument();
  });

  it('offers a retry only where there is something to retry', () => {
    const { rerender } = renderCard({
      data: data([node({ totalErrors: 3, items: [] })]),
    });
    expect(
      screen.getByRole('button', { name: 'Retry resync' })
    ).toBeInTheDocument();

    rerender(
      <BlockErrorsCard
        data={data([node({ nodeId: KEY_B, error: 'unreachable' })])}
        error={null}
        loading={false}
        nodeNames={names}
        onRetried={async () => {}}
      />
    );
    // A retry against a node that did not answer would be a guess.
    expect(
      screen.queryByRole('button', { name: 'Retry resync' })
    ).not.toBeInTheDocument();
  });

  it('renders a missing scope as advice rather than a generic red bar', () => {
    renderCard({
      data: null,
      error:
        'The Garage cluster refused ListBlockErrors. The admin token is probably missing that scope — it was added in this release.',
    });

    const message = screen.getByText(/refused ListBlockErrors/);
    expect(message).toBeInTheDocument();
    expect(message.className).not.toContain('text-destructive');
  });
});
