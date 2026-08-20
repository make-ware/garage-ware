import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClusterUnavailableNotice } from './cluster-unavailable';

describe('ClusterUnavailableNotice', () => {
  it('offers exactly one link, to the Garage project page', () => {
    const { container } = render(<ClusterUnavailableNotice />);
    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute('href')).toBe(
      'https://garagehq.deuxfleurs.fr/'
    );
    expect(anchors[0].getAttribute('target')).toBe('_blank');
    expect(anchors[0].getAttribute('rel')).toContain('noopener');
    expect(anchors[0].getAttribute('rel')).toContain('noreferrer');
  });

  it('renders nothing an administrator would be told', () => {
    // This page is redacted for every signed-in user: no env var names, no
    // admin-facing documentation.
    const { container } = render(<ClusterUnavailableNotice />);
    expect(container.textContent).not.toMatch(
      /GARAGE_ADMIN_URL|GARAGE_ADMIN_TOKEN|admin token/i
    );
    for (const a of container.querySelectorAll('a')) {
      expect(a.getAttribute('href')).not.toMatch(
        /garagehq\.deuxfleurs\.fr\/documentation/
      );
    }
  });

  it('points the reader at their administrator', () => {
    const { container } = render(<ClusterUnavailableNotice />);
    expect(screen.getByText('Cluster unavailable')).toBeInTheDocument();
    expect(container.textContent).toMatch(/administrator/i);
  });
});
