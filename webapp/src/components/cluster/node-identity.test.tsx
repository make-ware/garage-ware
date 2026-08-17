import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeIdentity } from './node-identity';

/** A realistic Garage node id, and the key it reduces to. */
const FULL_ID =
  'abcdef0123456789fedcba98765432100123456789abcdeffedcba9876543210';
const KEY = 'abcdef0123456789';

describe('NodeIdentity', () => {
  it('shows the name above the node key', () => {
    render(<NodeIdentity name="vault-01" nodeId={FULL_ID} />);
    expect(screen.getByText('vault-01')).toBeInTheDocument();
    expect(screen.getByText(KEY)).toBeInTheDocument();
  });

  it('shows an unnamed node on one line only', () => {
    // The doubled-line case is the one that regresses silently.
    const { container } = render(<NodeIdentity name={null} nodeId={FULL_ID} />);
    expect(screen.getByText(KEY)).toBeInTheDocument();
    expect(container.querySelectorAll('span')).toHaveLength(1);
  });

  it('never renders a full node id, even handed one', () => {
    // The full id is the credential the node-claim route accepts. Callers pass
    // whatever their payload carried, so the component normalises rather than
    // trusting them.
    const { container } = render(
      <NodeIdentity name="vault-01" nodeId={FULL_ID} />
    );
    expect(container.textContent).not.toContain(FULL_ID);
  });

  it('renders the suffix slot alongside the label', () => {
    render(
      <NodeIdentity name={null} nodeId={FULL_ID}>
        <span> (not in layout)</span>
      </NodeIdentity>
    );
    expect(screen.getByText('(not in layout)')).toBeInTheDocument();
  });
});
