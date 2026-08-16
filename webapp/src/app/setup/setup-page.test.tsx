import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SetupPage from './page';

const { mockApi, mockUseAuth } = vi.hoisted(() => ({
  mockApi: vi.fn(),
  mockUseAuth: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  api: mockApi,
  ApiError: class ApiError extends Error {},
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: mockUseAuth }));

function signedOut() {
  mockUseAuth.mockReturnValue({
    isAuthenticated: false,
    isLoading: false,
    user: null,
  });
}

function signedIn() {
  mockUseAuth.mockReturnValue({
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'u1', email: 'owner@example.com' },
  });
}

describe('SetupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('walks an unclaimed instance through the numbered steps', async () => {
    signedOut();
    mockApi.mockImplementation(async (path: string) => {
      if (path === '/next-api/setup/status') {
        return {
          claimed: false,
          pocketbaseOk: true,
          signupMode: 'invite',
          needsGarageConfig: true,
        };
      }
      throw new Error('unexpected call: ' + path);
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText('Set up this instance')).toBeInTheDocument()
    );
    expect(screen.getByText('Create your account')).toBeInTheDocument();
    expect(
      screen.getByText('Claim the administrator role')
    ).toBeInTheDocument();
    expect(screen.getByText('Connect your Garage cluster')).toBeInTheDocument();
    // Signed out: the token field must not be offered yet, since the claim
    // needs an identity to grant the role to.
    expect(screen.queryByLabelText('Claim token')).not.toBeInTheDocument();
  });

  it('offers the token field and says where to find it once signed in', async () => {
    signedIn();
    mockApi.mockImplementation(async (path: string) => {
      if (path === '/next-api/setup/status') {
        return {
          claimed: false,
          pocketbaseOk: true,
          signupMode: 'invite',
          needsGarageConfig: false,
        };
      }
      if (path === '/next-api/status') {
        return {
          generatedAt: '2026-08-16T09:00:00.000Z',
          overall: 'ok',
          checks: [
            {
              id: 'garage-admin-api',
              label: 'Garage admin API',
              state: 'ok',
              detail: 'Reachable.',
            },
          ],
        };
      }
      throw new Error('unexpected call: ' + path);
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByLabelText('Claim token')).toBeInTheDocument()
    );
    expect(screen.getByText(/\/data\/setup\/claim-token/)).toBeInTheDocument();
    // The diagnostics are embedded, which is the whole reason the status route
    // is readable before an admin exists.
    await waitFor(() =>
      expect(screen.getByText('Garage admin API')).toBeInTheDocument()
    );
  });

  it('refuses to show the wizard on an already-claimed instance', async () => {
    signedOut();
    mockApi.mockResolvedValue({
      claimed: true,
      pocketbaseOk: true,
      signupMode: 'invite',
      needsGarageConfig: false,
    });

    render(<SetupPage />);
    await waitFor(() =>
      expect(
        screen.getByText('This instance is already set up')
      ).toBeInTheDocument()
    );
    expect(screen.queryByLabelText('Claim token')).not.toBeInTheDocument();
    expect(screen.queryByText('Set up this instance')).not.toBeInTheDocument();
  });

  it('surfaces an unreachable instance instead of rendering a broken wizard', async () => {
    signedOut();
    mockApi.mockRejectedValue(new Error('Failed to fetch'));

    render(<SetupPage />);
    await waitFor(() =>
      expect(screen.getByText('Cannot reach this instance')).toBeInTheDocument()
    );
  });
});
