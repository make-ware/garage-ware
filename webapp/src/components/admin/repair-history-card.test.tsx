import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RepairHistoryCard, REPAIR_HISTORY_ROWS } from './repair-history-card';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: mocks.api }));

const KEY_A = 'aaaa000000000001';
const names = new Map<string, string | null>([[KEY_A, 'vault-01']]);

const row = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  kind: 'repair',
  source: 'action',
  severity: 'info',
  category: 'maintenance',
  node_id: KEY_A,
  node_hostname: '',
  node_zone: '',
  title: 'Block resync retried',
  detail: '41,233 blocks re-queued for resync',
  previous_value: '',
  new_value: 'retry-resync',
  occurred_at: '2026-08-20 12:00:00.000Z',
  ended_at: '2026-08-20 12:00:00.000Z',
  occurrence_count: 0,
  actor_id: 'u1',
  actor_email: 'admin@example.com',
  ...over,
});

function renderCard() {
  return render(<RepairHistoryCard nodeNames={names} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockResolvedValue({
    items: [row()],
    page: 1,
    perPage: REPAIR_HISTORY_ROWS,
    totalItems: 1,
    totalPages: 1,
  });
});

describe('RepairHistoryCard', () => {
  it('asks for repair rows only, and only a page of them', async () => {
    renderCard();
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    expect(mocks.api).toHaveBeenCalledWith('/next-api/garage/events', {
      query: { kind: 'repair', perPage: REPAIR_HISTORY_ROWS },
    });
  });

  it('renders the raw operation id and the detail beside the title', async () => {
    // The three fields the redacted `ClusterTimelineEvent` projection drops,
    // and the reason this card is not `ClusterEventTimeline`.
    renderCard();

    expect(await screen.findByText('Block resync retried')).toBeInTheDocument();
    expect(screen.getByText('retry-resync')).toBeInTheDocument();
    expect(
      screen.getByText('41,233 blocks re-queued for resync')
    ).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('vault-01')).toBeInTheDocument();
  });

  it('renders a warning row’s detail', async () => {
    mocks.api.mockResolvedValue({
      items: [
        row({
          id: 'e2',
          severity: 'warning',
          title: 'Block repair failed to start',
          new_value: 'blocks',
          detail: 'node is not responding',
        }),
      ],
      page: 1,
      perPage: REPAIR_HISTORY_ROWS,
      totalItems: 1,
      totalPages: 1,
    });
    renderCard();

    expect(
      await screen.findByText('node is not responding')
    ).toBeInTheDocument();
  });

  it('renders a full page of rows', async () => {
    mocks.api.mockResolvedValue({
      items: Array.from({ length: REPAIR_HISTORY_ROWS }, (_, i) =>
        row({ id: `e${i}` })
      ),
      page: 1,
      perPage: REPAIR_HISTORY_ROWS,
      totalItems: 40,
      totalPages: 2,
    });
    renderCard();

    await waitFor(() =>
      expect(screen.getAllByText('Block resync retried')).toHaveLength(
        REPAIR_HISTORY_ROWS
      )
    );
  });

  it('says "launched from this app" when empty, not "no repairs"', async () => {
    // Garage's own automatic monthly scrub is not in ClusterEvents and never
    // will be, so "no repairs" would be false on every healthy cluster.
    mocks.api.mockResolvedValue({
      items: [],
      page: 1,
      perPage: REPAIR_HISTORY_ROWS,
      totalItems: 0,
      totalPages: 0,
    });
    renderCard();

    expect(
      await screen.findByText('No repairs have been launched from this app.')
    ).toBeInTheDocument();
  });

  it('degrades to one muted line when the fetch fails', async () => {
    mocks.api.mockRejectedValue(new Error('boom'));
    renderCard();

    expect(
      await screen.findByText('Could not read the repair history.')
    ).toBeInTheDocument();
  });
});
