import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AdminStatusPage from './page';
import type { Check, Diagnostics } from '@/lib/setup/diagnostics';

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));

vi.mock('@/lib/api-client', () => ({
  api: mockApi,
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const NO_CLUSTER: Check[] = [
  {
    id: 'garage-admin-api',
    label: 'Garage admin API',
    state: 'fail',
    detail:
      'GARAGE_ADMIN_URL and GARAGE_ADMIN_TOKEN not set — this deployment is not connected to a cluster.',
    hint: 'Set GARAGE_ADMIN_URL and GARAGE_ADMIN_TOKEN.',
  },
  {
    id: 'garage-layout',
    label: 'Garage layout',
    state: 'unknown',
    detail: 'Cannot be read until the admin API is configured.',
  },
];

const HEALTHY: Check[] = [
  {
    id: 'garage-admin-api',
    label: 'Garage admin API',
    state: 'ok',
    detail: 'Reachable at 10.0.0.5:3903.',
  },
  {
    id: 'garage-layout',
    label: 'Garage layout',
    state: 'ok',
    detail: 'Layout version 4, replication factor 3, 3 storage node(s).',
  },
];

function diagnostics(checks: Check[], overall: Diagnostics['overall']) {
  return { generatedAt: '2026-08-16T09:00:00.000Z', overall, checks };
}

describe('AdminStatusPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the Garage installation docs when no cluster is reachable', async () => {
    mockApi.mockResolvedValue(diagnostics(NO_CLUSTER, 'fail'));

    const { container } = render(<AdminStatusPage />);
    await waitFor(() =>
      expect(screen.getByText('No cluster yet?')).toBeInTheDocument()
    );
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) =>
      a.getAttribute('href')
    );
    expect(hrefs).toContain(
      'https://garagehq.deuxfleurs.fr/documentation/quick-start/'
    );
  });

  it('puts the card below the checks, not in place of them', async () => {
    mockApi.mockResolvedValue(diagnostics(NO_CLUSTER, 'fail'));

    render(<AdminStatusPage />);
    await waitFor(() =>
      expect(screen.getByText('No cluster yet?')).toBeInTheDocument()
    );
    const checksList = screen.getByText('Garage admin API').closest('ul');
    const card = screen.getByText('No cluster yet?');
    if (!checksList) throw new Error('the checks list did not render');
    // DOCUMENT_POSITION_FOLLOWING: the card comes after the checks in the
    // document. The failing check's own hint is the first thing to read.
    expect(
      checksList.compareDocumentPosition(card) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('offers the config generator beside the docs, for a truly empty start', async () => {
    // Admin-only, so the link lives on this page rather than inside
    // `NoClusterCard` — that card is also rendered by `/setup` step 3, which
    // is reachable before anyone is an admin.
    mockApi.mockResolvedValue(diagnostics(NO_CLUSTER, 'fail'));

    const { container } = render(<AdminStatusPage />);
    await waitFor(() =>
      expect(screen.getByText('No cluster yet?')).toBeInTheDocument()
    );
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) =>
      a.getAttribute('href')
    );
    expect(hrefs).toContain('/admin/setup/config-generator');
  });

  it('says nothing about installing Garage when the cluster is fine', async () => {
    mockApi.mockResolvedValue(diagnostics(HEALTHY, 'ok'));

    const { container } = render(<AdminStatusPage />);
    await waitFor(() =>
      expect(screen.getByText('Garage admin API')).toBeInTheDocument()
    );
    expect(screen.queryByText('No cluster yet?')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/does not install/i);
    // The generator is for operators with no cluster; a healthy deployment
    // has no business being pointed at it from here.
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) =>
      a.getAttribute('href')
    );
    expect(hrefs).not.toContain('/admin/setup/config-generator');
  });

  it('does not guess at a missing cluster when the status call itself failed', async () => {
    // No diagnostics means no evidence either way — an unreadable status route
    // says nothing about whether a cluster exists.
    mockApi.mockRejectedValue(new Error('Forbidden'));

    render(<AdminStatusPage />);
    await waitFor(() =>
      expect(screen.getByText('Forbidden')).toBeInTheDocument()
    );
    expect(screen.queryByText('No cluster yet?')).not.toBeInTheDocument();
  });
});
