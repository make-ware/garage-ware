import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoginForm } from '@/components/auth/login-form';
import { AuthProvider } from '@/contexts/auth-context';

// Use vi.hoisted() to ensure mocks are available when vi.mock() is hoisted
const { mockPb, mockAuthHelpers, mockCollection } = vi.hoisted(() => {
  const mockAuthHelpers = {
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    getCurrentUser: vi.fn(() => null),
    isAuthenticated: vi.fn(() => false),
    updateProfile: vi.fn(),
    changePassword: vi.fn(),
    requestPasswordReset: vi.fn(),
    confirmPasswordReset: vi.fn(),
  };

  const mockAuthStore = {
    isValid: false,
    model: null,
    onChange: vi.fn(() => vi.fn()), // Returns unsubscribe function
    clear: vi.fn(),
  };

  const mockCollection = {
    authWithPassword: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };

  const mockPb = {
    authStore: mockAuthStore,
    collection: vi.fn(() => mockCollection),
    autoCancellation: vi.fn(),
  };

  return { mockPb, mockAuthHelpers, mockCollection };
});

vi.mock('@/lib/pocketbase', () => ({
  default: mockPb,
  authHelpers: mockAuthHelpers,
  getUserCollection: () => mockCollection,
}));

// The sign-up link renders only when the instance reports open sign-ups; the
// hook seeds fail-safe at `closed`, so tests set the mode per case.
const mockSetupStatus = vi.hoisted(() => ({
  status: { claimed: true, signupMode: 'open' as string },
  loaded: true,
  error: null as string | null,
}));

vi.mock('@/lib/setup/use-setup-status', () => ({
  useSetupStatus: () => mockSetupStatus,
}));

describe('LoginForm Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetupStatus.status = { claimed: true, signupMode: 'open' };
  });

  const renderLoginForm = () => {
    return render(
      <AuthProvider>
        <LoginForm />
      </AuthProvider>
    );
  };

  it('renders login form with email and password fields', () => {
    renderLoginForm();

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /sign in/i })
    ).toBeInTheDocument();
  });

  it('renders remember me checkbox', () => {
    renderLoginForm();

    expect(
      screen.getByRole('checkbox', { name: /remember me/i })
    ).toBeInTheDocument();
  });

  it('renders sign up link with correct href when sign-ups are open', () => {
    renderLoginForm();

    const signUpLink = screen.getByRole('link', { name: /sign up/i });
    expect(signUpLink).toHaveAttribute('href', '/signup');
  });

  it('hides the sign up link when sign-ups are not open', () => {
    mockSetupStatus.status = { claimed: true, signupMode: 'closed' };
    renderLoginForm();

    expect(
      screen.queryByRole('link', { name: /sign up/i })
    ).not.toBeInTheDocument();
  });

  it('has email input with correct type attribute', () => {
    renderLoginForm();

    const emailInput = screen.getByLabelText(/email/i);
    expect(emailInput).toHaveAttribute('type', 'email');
  });

  it('has password input with correct type attribute', () => {
    renderLoginForm();

    const passwordInput = screen.getByLabelText(/password/i);
    expect(passwordInput).toHaveAttribute('type', 'password');
  });
});
