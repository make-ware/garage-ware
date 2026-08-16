import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StorageCostSummary } from './storage-cost-summary';
import { DEFAULT_PRICING_CONFIG } from '@/lib/pricing/rates';
import { TERABYTE } from '@/lib/storage/units';

const base = {
  quotaBytes: 36 * TERABYTE,
  replicationFactor: 3,
  pricing: DEFAULT_PRICING_CONFIG,
};

describe('StorageCostSummary', () => {
  it('renders the skeleton while loading', () => {
    render(<StorageCostSummary {...base} loading />);
    expect(screen.getByLabelText('Loading storage costs')).toBeDefined();
  });

  it('shows what the quota costs here and what it saves against each provider', () => {
    // Both savings, not just the headline: quoting only the dearest invites
    // "but B2 is cheap", and volunteering the narrow figure answers it.
    const { container } = render(<StorageCostSummary {...base} />);
    expect(container.textContent).toMatch(/\$475\.20/);
    expect(container.textContent).toMatch(/what your 36 TB costs here/);
    expect(container.textContent).toMatch(/\$12,593/);
    expect(container.textContent).toMatch(/saved a year vs Amazon S3/);
    expect(container.textContent).toMatch(/\$2,527/);
    expect(container.textContent).toMatch(/saved a year vs Backblaze B2/);
  });

  it('keeps only the cheapest comparison on mobile', () => {
    // One comparison fits on a phone, and it should be the cheapest provider:
    // the hardest test of the claim, and the one a user weighing alternatives
    // would actually price against.
    render(<StorageCostSummary {...base} />);
    // The label's parent is the stat block that carries the visibility class.
    const s3 = screen.getByText('saved a year vs Amazon S3').parentElement!;
    const b2 = screen.getByText('saved a year vs Backblaze B2').parentElement!;
    expect(s3.className).toMatch(/hidden sm:block/);
    expect(b2.className).not.toMatch(/hidden/);
    // Both figures are still in the DOM — this is a layout choice, not a
    // different set of numbers on phones.
    expect(s3.textContent).toMatch(/\$12,593/);
    expect(b2.textContent).toMatch(/\$2,527/);
  });

  it('links to the cluster page, where the full comparison lives', () => {
    render(<StorageCostSummary {...base} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/dashboard/cluster');
  });

  it('stays a one-line summary — no bars, no table, no rates', () => {
    // If this starts failing, the widget is growing back into the full panel
    // that was moved off this screen in the first place. Provider *names* are
    // fine — it is the per-provider rate rows and bars that belong on /cluster.
    const { container } = render(<StorageCostSummary {...base} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/TB\/mo/);
    expect(container.textContent).not.toMatch(/\/yr.*\/yr/);
  });

  it('says something useful, and still links out, with no quota yet', () => {
    const { container } = render(
      <StorageCostSummary {...base} quotaBytes={0} />
    );
    expect(container.textContent).toMatch(/Ask an administrator for a quota/);
    expect(container.textContent).not.toMatch(/\$0\.00/);
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      '/dashboard/cluster'
    );
  });

  it('scales the cluster cost with the replication factor', () => {
    const { container } = render(
      <StorageCostSummary {...base} replicationFactor={1} />
    );
    // A third of the RF-3 hardware cost.
    expect(container.textContent).toMatch(/\$158\.40/);
  });
});
