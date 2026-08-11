import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeIdentity } from './node-identity';

describe('NodeIdentity', () => {
  it('shows the name above the short id', () => {
    render(<NodeIdentity name="vault-01" nodeId="abcdef0123456789" />);
    expect(screen.getByText('vault-01')).toBeInTheDocument();
    expect(screen.getByText('abcdef01…')).toBeInTheDocument();
  });

  it('shows an unnamed node on one line only', () => {
    // The doubled-line case is the one that regresses silently.
    const { container } = render(
      <NodeIdentity name={null} nodeId="abcdef0123456789" />
    );
    expect(screen.getByText('abcdef01…')).toBeInTheDocument();
    expect(container.querySelectorAll('span')).toHaveLength(1);
  });

  it('renders the suffix slot alongside the label', () => {
    render(
      <NodeIdentity name={null} nodeId="abcdef0123456789">
        <span> (not in layout)</span>
      </NodeIdentity>
    );
    expect(screen.getByText('(not in layout)')).toBeInTheDocument();
  });
});
