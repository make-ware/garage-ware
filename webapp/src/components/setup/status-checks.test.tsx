import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  formatDiagnostics,
  StatusChecks,
  type Check,
  type Diagnostics,
} from './status-checks';

const checks: Check[] = [
  {
    id: 'pocketbase-superuser',
    label: 'PocketBase superuser',
    state: 'ok',
    detail: 'Credentials are set and authenticate successfully.',
  },
  {
    id: 'garage-admin-api',
    label: 'Garage admin API',
    state: 'fail',
    detail: 'Connection refused by the Garage admin API (10.0.0.5:3903)',
    hint: 'Check this is the admin port (3903), not the S3 port (3900).',
  },
  {
    id: 'smtp',
    label: 'Email (SMTP)',
    state: 'warn',
    detail: 'SMTP is not enabled.',
  },
  {
    id: 'garage-layout',
    label: 'Garage layout',
    state: 'unknown',
    detail: 'Cannot be read while the admin API check is failing.',
  },
];

describe('StatusChecks', () => {
  it('renders every check with its label, detail and hint', () => {
    render(<StatusChecks checks={checks} />);
    for (const c of checks) {
      expect(screen.getByText(c.label)).toBeInTheDocument();
      expect(screen.getByText(c.detail)).toBeInTheDocument();
    }
    expect(
      screen.getByText(/Check this is the admin port/)
    ).toBeInTheDocument();
  });

  it('labels each state in words, not by colour alone', () => {
    // Colour is not available to everyone; the state has to be readable.
    render(<StatusChecks checks={checks} />);
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.getByText('Not working')).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('renders nothing but an empty list when there are no checks', () => {
    const { container } = render(<StatusChecks checks={[]} />);
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });
});

describe('formatDiagnostics', () => {
  const diagnostics: Diagnostics = {
    generatedAt: '2026-08-16T09:00:00.000Z',
    overall: 'fail',
    checks,
  };

  it('includes every check, its state and its hint', () => {
    const text = formatDiagnostics(diagnostics);
    expect(text).toContain('overall: fail');
    for (const c of checks) {
      expect(text).toContain(c.label);
      expect(text).toContain(c.detail);
    }
    expect(text).toContain('-> Check this is the admin port');
  });

  it('matches what the page rendered, so a pasted report is not a different story', () => {
    render(<StatusChecks checks={checks} />);
    const text = formatDiagnostics(diagnostics);
    for (const c of checks) {
      expect(screen.getByText(c.detail)).toBeInTheDocument();
      expect(text).toContain(c.detail);
    }
  });
});
