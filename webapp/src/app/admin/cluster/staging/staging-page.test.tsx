import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ClusterStagingPage from './page';
import { CONFLICT_COPY, STAGE_ONLY_NOTICE } from '@/lib/cluster/staging-copy';

/**
 * The staging page, at the two moments that matter: a stage in flight, and a
 * version conflict.
 *
 * The conflict case is the one worth pinning. `UpdateClusterLayout` has no
 * version parameter, so a 409 here is entirely this app's doing — and the
 * correct response to it is to *stop*. An automatic retry would stage a change
 * against a layout nobody has looked at.
 */

const { mockApi, ApiError } = vi.hoisted(() => ({
  mockApi: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/lib/api-client', () => ({ api: mockApi, ApiError }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const KEY_A = 'aaaa000000000001';
const TB = 1_000_000_000_000;

const PAYLOAD = {
  version: 12,
  replicationFactor: 3,
  parameters: { zoneRedundancy: 'maximum' },
  partitionSize: 1_000_000,
  roles: [
    {
      id: KEY_A,
      zone: 'dc1',
      capacity: 16 * TB,
      tags: ['ssd', 'name:vault-01'],
    },
  ],
  staged: [] as unknown[],
  stagedFingerprint: '',
  stagedParametersPending: false,
  candidates: [
    { id: KEY_A, name: 'vault-01', zone: 'dc1', inLayout: true, isUp: true },
  ],
  fetchedAt: '2026-08-20T00:00:00.000Z',
};

/** Route the mocked `api()` by verb: the GET seeds, the POST is under test. */
function setup(post: (body: unknown) => unknown) {
  mockApi.mockImplementation(
    async (_path: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === 'POST') return post(options.body);
      if (_path.includes('layout-history')) throw new Error('no history');
      return PAYLOAD;
    }
  );
  return render(<ClusterStagingPage />);
}

const stageButton = () => screen.getByRole('button', { name: 'Stage change' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the layout staging page', () => {
  it('states the boundary before anything is fetched', () => {
    const { container } = setup(() => PAYLOAD);
    expect(container.textContent).toContain(STAGE_ONLY_NOTICE);
  });

  it('prefills the form from the node’s current role', async () => {
    setup(() => PAYLOAD);
    await screen.findByText('Stage a change');

    expect((screen.getByLabelText('Zone') as HTMLInputElement).value).toBe(
      'dc1'
    );
    expect((screen.getByLabelText('Capacity') as HTMLInputElement).value).toBe(
      '16'
    );
    // The whole tag list, `name:` included — the API writes all of them or
    // none, so what is shown is what will be sent.
    expect(
      (screen.getByLabelText('Tags (comma separated)') as HTMLInputElement)
        .value
    ).toBe('ssd, name:vault-01');
  });

  it('sends the version and fingerprint it was served, and disables the button in flight', async () => {
    let resolve: (value: unknown) => void = () => {};
    const pending = new Promise((r) => {
      resolve = r;
    });
    let sent: unknown = null;
    setup((body) => {
      sent = body;
      return pending;
    });
    await screen.findByText('Stage a change');

    fireEvent.change(screen.getByLabelText('Capacity'), {
      target: { value: '32' },
    });
    fireEvent.click(stageButton());

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Staging…' })).toBeDefined()
    );
    expect(
      (screen.getByRole('button', { name: 'Staging…' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(sent).toMatchObject({
      expectedVersion: 12,
      expectedStagedFingerprint: '',
      changes: [
        {
          action: 'assign',
          nodeId: KEY_A,
          zone: 'dc1',
          gateway: false,
          capacityBytes: 32 * TB,
          tags: ['ssd', 'name:vault-01'],
        },
      ],
    });

    resolve({ ...PAYLOAD, logged: true });
    await waitFor(() => expect(stageButton()).toBeDefined());
  });

  it('surfaces a conflict and does not stage again', async () => {
    const post = vi.fn(() => {
      throw new ApiError(
        409,
        'The cluster layout changed since you loaded this page (it is now version 13).'
      );
    });
    setup(post);
    await screen.findByText('Stage a change');

    fireEvent.click(stageButton());

    await screen.findByText('Nothing was staged');
    expect(document.body.textContent).toContain('it is now version 13');
    expect(document.body.textContent).toContain(CONFLICT_COPY);
    // One attempt, no retry.
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDefined();
  });

  it('shows the next-steps command only once something is staged', async () => {
    setup(() => PAYLOAD);
    await screen.findByText('Stage a change');
    expect(document.body.textContent).not.toContain('garage layout apply');

    mockApi.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path.includes('layout-history')) throw new Error('no history');
        const staged = [
          { id: KEY_A, zone: 'dc1', capacity: 32 * TB, tags: ['ssd'] },
        ];
        return options?.method === 'POST'
          ? { ...PAYLOAD, staged, stagedFingerprint: 'x', logged: true }
          : PAYLOAD;
      }
    );
    fireEvent.click(stageButton());

    await screen.findByText('Next steps — run these yourself');
    expect(document.body.textContent).toContain(
      'garage layout apply --version 13'
    );
  });

  it('renders a cluster failure rather than a blank page', async () => {
    mockApi.mockRejectedValue(new Error('fetch failed: connection refused'));
    render(<ClusterStagingPage />);

    await screen.findByText('The cluster could not be reached');
    expect(document.body.textContent).toContain('connection refused');
  });
});
