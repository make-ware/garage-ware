import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ConfigGeneratorPage from './page';
import { REPLICATION_TRADEOFFS } from '@/lib/garage-config/garage-toml-copy';

/**
 * The page's two obligations.
 *
 * One: the preview is genuinely live — the file an operator downloads is a
 * function of the form in front of them, not a stale render. Replication factor
 * is the field worth asserting on because it is the one whose *wrong* value is
 * silent: a cluster built at factor 1 works perfectly until a disk dies.
 *
 * Two: no input on this page asks for a secret. That is checked structurally in
 * `garage-toml-secrets.test.ts` at the module level; here it is checked at the
 * DOM level, because a password field could be added to the form component
 * without `GarageConfigInput` changing at all.
 */

/** The `<pre>` holding the generated file, addressed the way the page builds it. */
function preview(): HTMLElement {
  const block = document.querySelector('pre');
  if (!block) throw new Error('the preview did not render');
  return block as HTMLElement;
}

const SECRET_WORDS = /secret|token|password|passphrase|credential|api[_-]?key/i;

describe('config generator page', () => {
  it('previews the default configuration without being asked', () => {
    render(<ConfigGeneratorPage />);

    expect(preview().textContent).toContain('replication_factor = 3');
    expect(preview().textContent).toContain(
      'metadata_dir = "/var/lib/garage/meta"'
    );
    expect(preview().textContent).toContain('api_bind_addr = "[::]:3903"');
  });

  it('updates the preview when the replication factor changes', () => {
    render(<ConfigGeneratorPage />);
    expect(preview().textContent).toContain('replication_factor = 3');

    fireEvent.click(screen.getByLabelText('1'));

    expect(preview().textContent).toContain('replication_factor = 1');
    expect(preview().textContent).not.toContain('replication_factor = 3');
  });

  it('shows the safety tradeoff for every factor, not just the chosen one', () => {
    // The choice is permanent in practice — changing it on a cluster holding
    // data is its own procedure — so the consequence has to be readable
    // before the click, not after.
    render(<ConfigGeneratorPage />);

    for (const factor of [3, 2, 1] as const) {
      expect(
        screen.getByText(REPLICATION_TRADEOFFS[factor])
      ).toBeInTheDocument();
    }
  });

  it('carries the factor-1 tradeoff into the generated file itself', () => {
    render(<ConfigGeneratorPage />);
    fireEvent.click(screen.getByLabelText('1'));

    // The file outlives the page: whoever reads /etc/garage.toml in a year is
    // not looking at this UI.
    expect(preview().textContent).toContain('No redundancy at all');
  });

  it('updates the preview when a port changes', () => {
    render(<ConfigGeneratorPage />);

    fireEvent.change(screen.getByLabelText('Admin API port'), {
      target: { value: '4903' },
    });

    expect(preview().textContent).toContain('api_bind_addr = "[::]:4903"');
  });

  it('adds root_domain only once it has been filled in', () => {
    render(<ConfigGeneratorPage />);
    expect(preview().textContent).not.toContain('root_domain');

    fireEvent.change(screen.getByLabelText('Root domain (optional)'), {
      target: { value: '.s3.example.com' },
    });

    expect(preview().textContent).toContain('root_domain = ".s3.example.com"');
  });

  it('explains an invalid configuration without blanking the preview', () => {
    render(<ConfigGeneratorPage />);

    fireEvent.change(screen.getByLabelText('Metadata directory'), {
      target: { value: 'var/lib/garage/meta' },
    });

    const alert = screen.getByRole('alert');
    expect(
      within(alert).getByText(/must be an absolute path/)
    ).toBeInTheDocument();
    // Still building: an operator fixing a path should not lose the file.
    expect(preview().textContent).toContain('replication_factor = 3');
  });

  it('reports an out-of-range port', () => {
    render(<ConfigGeneratorPage />);

    fireEvent.change(screen.getByLabelText('RPC port'), {
      target: { value: '0' },
    });

    expect(
      within(screen.getByRole('alert')).getByText(
        /RPC port must be a whole number/
      )
    ).toBeInTheDocument();
  });

  it('reports a plan with fewer nodes than the replication factor needs', () => {
    render(<ConfigGeneratorPage />);

    fireEvent.change(screen.getByLabelText('Nodes'), {
      target: { value: '2' },
    });

    expect(
      within(screen.getByRole('alert')).getByText(
        /needs at least 3 storage nodes/
      )
    ).toBeInTheDocument();
  });

  it('restores the defaults on reset', () => {
    render(<ConfigGeneratorPage />);
    const reset = screen.getByRole('button', { name: /Reset/ });
    expect(reset).toBeDisabled();

    fireEvent.click(screen.getByLabelText('1'));
    expect(reset).toBeEnabled();
    fireEvent.click(reset);

    expect(preview().textContent).toContain('replication_factor = 3');
    expect(reset).toBeDisabled();
  });
});

describe('config generator page — no secret ever reaches this form', () => {
  it('renders no password input and no field named like a credential', () => {
    const { container } = render(<ConfigGeneratorPage />);
    const inputs = Array.from(container.querySelectorAll('input'));
    expect(inputs.length).toBeGreaterThan(0);

    for (const input of inputs) {
      expect(input.getAttribute('type')).not.toBe('password');

      // The accessible name, however it is supplied.
      const label = input.id
        ? container.querySelector(`label[for="${input.id}"]`)?.textContent
        : null;
      const name = [
        label,
        input.getAttribute('aria-label'),
        input.getAttribute('name'),
        input.getAttribute('placeholder'),
        input.id,
      ]
        .filter(Boolean)
        .join(' ');
      expect(name).not.toMatch(SECRET_WORDS);
    }
  });

  it('says out loud that it never asks for one', () => {
    const { container } = render(<ConfigGeneratorPage />);
    expect(container.textContent).toMatch(/never asks for a secret/i);
    expect(container.textContent).toMatch(/does not install or run GarageHQ/i);
  });

  it('emits placeholders and the command that fills each of them', () => {
    render(<ConfigGeneratorPage />);
    const toml = preview().textContent ?? '';

    expect(toml).toContain('rpc_secret = "@RPC_SECRET@"');
    expect(toml).toContain('openssl rand -hex 32');
    expect(toml).toContain('# admin_token = "@ADMIN_TOKEN@"');
    expect(toml).toContain('garage admin-token create --name garage-ware');
  });
});
