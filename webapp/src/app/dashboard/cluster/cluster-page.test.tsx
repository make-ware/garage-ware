import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ClusterPage from './page';

const { mockApi, MockApiError } = vi.hoisted(() => ({
  mockApi: vi.fn(),
  // Faithful to the real class: `status` is what the page discriminates on, and
  // a mock without it makes `err.status === 503` compare `undefined`, so every
  // case below would pass for the wrong reason.
  MockApiError: class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

vi.mock('@/lib/api-client', () => ({
  api: mockApi,
  ApiError: MockApiError,
}));
vi.mock('@/lib/pocketbase', () => ({ default: {} }));
vi.mock('@/components/auth/protected-route', () => ({
  ProtectedRoute: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/lib/metrics/latest-node-metrics', () => ({
  fetchLatestNodeMetrics: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/pricing/use-pricing-config', () => ({
  usePricingConfig: () => ({
    config: { garageUsdPerTb: 22, hardwareLifespanYears: 5, ratesAsOf: '2026' },
    error: null,
  }),
}));
vi.mock('@/components/cluster/cluster-map', () => ({
  ClusterMap: () => <div data-testid="cluster-map" />,
}));
vi.mock('@/components/cluster/cluster-event-timeline', () => ({
  ClusterEventTimeline: () => <div data-testid="cluster-timeline" />,
}));

/** The class the mocked module exports, so `instanceof` matches inside the page. */
function apiError(status: number, message: string) {
  return new MockApiError(status, message);
}

const NODES = {
  items: [
    {
      id: 'abcdef0123456789',
      zone: 'dc1',
      capacity: 1_000_000_000_000,
      tags: ['name:alpha'],
    },
  ],
  replicationFactor: 3,
  layoutVersion: 4,
};

/** Route the layout call to `onNodes`; everything else is enrichment. */
function routeApi(onNodes: () => unknown) {
  mockApi.mockImplementation(async (path: string) => {
    if (path === '/next-api/garage/cluster/nodes') return onNodes();
    if (path === '/next-api/garage/cluster/events') {
      return { items: [], openEvents: [], totalItems: 0 };
    }
    return { netGrantedGb: 0 };
  });
}

describe('ClusterPage when the cluster is unreachable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces the not-configured 503 body with a redacted notice', async () => {
    const err = apiError(
      503,
      'This deployment is not connected to a Garage cluster yet. An administrator needs to set GARAGE_ADMIN_URL and GARAGE_ADMIN_TOKEN.'
    );
    routeApi(() => {
      throw err;
    });

    const { container } = render(<ClusterPage />);
    await waitFor(() =>
      expect(screen.getByText('Cluster unavailable')).toBeInTheDocument()
    );
    // The whole point: the admin-facing body never reaches a regular user.
    expect(container.textContent).not.toMatch(/GARAGE_ADMIN_URL/);
  });

  it('suppresses the 502 admin-token body too', async () => {
    const err = apiError(
      502,
      'The Garage cluster rejected this deployment’s admin token. An administrator needs to check GARAGE_ADMIN_TOKEN.'
    );
    routeApi(() => {
      throw err;
    });

    const { container } = render(<ClusterPage />);
    await waitFor(() =>
      expect(screen.getByText('Cluster unavailable')).toBeInTheDocument()
    );
    expect(container.textContent).not.toMatch(/GARAGE_ADMIN_TOKEN/);
  });

  it('still shows a genuine 500 in the red bar', async () => {
    const err = apiError(500, 'Something broke');
    routeApi(() => {
      throw err;
    });

    render(<ClusterPage />);
    await waitFor(() =>
      expect(screen.getByText('Something broke')).toBeInTheDocument()
    );
    expect(screen.queryByText('Cluster unavailable')).not.toBeInTheDocument();
  });

  it('shows neither when the layout loads', async () => {
    routeApi(() => NODES);

    render(<ClusterPage />);
    await waitFor(() =>
      expect(screen.getByTestId('cluster-map')).toBeInTheDocument()
    );
    expect(screen.queryByText('Cluster unavailable')).not.toBeInTheDocument();
  });

  it('clears the notice once the cluster answers again', async () => {
    const err = apiError(503, 'unreachable');
    let fail = true;
    routeApi(() => {
      if (fail) throw err;
      return NODES;
    });

    render(<ClusterPage />);
    await waitFor(() =>
      expect(screen.getByText('Cluster unavailable')).toBeInTheDocument()
    );

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(screen.queryByText('Cluster unavailable')).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('cluster-map')).toBeInTheDocument();
  });
});
