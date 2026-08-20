import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NoClusterCard } from './no-cluster-card';

describe('NoClusterCard', () => {
  // Literal hrefs, not GARAGE_ADMIN_DOC_LINKS[i].href — iterating the constant
  // passes just as happily when a URL is wrong.
  it('links to the three Garage documentation pages', () => {
    const { container } = render(<NoClusterCard />);
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) =>
      a.getAttribute('href')
    );
    expect(hrefs).toContain(
      'https://garagehq.deuxfleurs.fr/documentation/quick-start/'
    );
    expect(hrefs).toContain(
      'https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/'
    );
    expect(hrefs).toContain(
      'https://garagehq.deuxfleurs.fr/documentation/cookbook/real-world/'
    );
  });

  it('opens every link in a new tab without leaking the referrer', () => {
    const { container } = render(<NoClusterCard />);
    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
      expect(a.getAttribute('rel')).toContain('noreferrer');
    }
  });

  it('says garage-ware manages a cluster rather than installing one', () => {
    const { container } = render(<NoClusterCard />);
    expect(screen.getByText('No cluster yet?')).toBeInTheDocument();
    expect(container.textContent).toMatch(/does not install/i);
    expect(container.textContent).toMatch(
      /manages an existing GarageHQ cluster/i
    );
  });

  it('names both environment variables the operator has to set', () => {
    const { container } = render(<NoClusterCard />);
    expect(container.textContent).toContain('GARAGE_ADMIN_URL');
    expect(container.textContent).toContain('GARAGE_ADMIN_TOKEN');
  });
});
