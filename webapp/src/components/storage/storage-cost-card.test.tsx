import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StorageCostCard } from './storage-cost-card';
import { CLUSTER_PANEL_CLASS } from '@/components/cluster/panel';
import { DEFAULT_PRICING_CONFIG } from '@/lib/pricing/rates';
import { TERABYTE } from '@/lib/storage/units';

/**
 * Expand every "View details" accordion. Radix unmounts collapsed content, so
 * the tables are genuinely absent until this runs — which is the behaviour the
 * collapsed-by-default tests below assert.
 */
function expandAll() {
  for (const trigger of screen.getAllByRole('button', {
    name: 'View details',
  })) {
    fireEvent.click(trigger);
  }
}

const base = {
  quotaBytes: 36 * TERABYTE,
  clusterUsableBytes: 120 * TERABYTE,
  replicationFactor: 3,
  pricing: DEFAULT_PRICING_CONFIG,
};

describe('StorageCostCard', () => {
  it('renders the skeleton while loading', () => {
    render(<StorageCostCard {...base} loading />);
    expect(screen.getByLabelText('Loading cost comparison')).toBeDefined();
  });

  it('shows both a user section and a cluster section', () => {
    // Separate blocks, not one blended figure: they answer different questions
    // — what am I getting, and what is this thing worth.
    const { container } = render(<StorageCostCard {...base} />);
    // Scoped to headings: "This cluster" is also a row label in both sections.
    expect(screen.getByRole('heading', { name: 'Your storage' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'This cluster' })).toBeDefined();
    expect(container.querySelectorAll('section')).toHaveLength(2);
    // A collapsed details accordion per section...
    expect(
      screen.getAllByRole('button', { name: 'View details' })
    ).toHaveLength(2);
    expect(container.querySelector('table')).toBeNull();
    // ...and a table with three provider rows in each, once opened.
    expandAll();
    expect(container.querySelectorAll('table')).toHaveLength(2);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(6);
  });

  it('keeps the tables collapsed until asked for', () => {
    // The headline answers the question; the table is the evidence, and on a
    // phone an open five-column table would be most of the screen.
    const { container } = render(<StorageCostCard {...base} />);
    expect(container.textContent).toMatch(/\$12,593/);
    expect(container.textContent).not.toMatch(/\$65,340/);
  });

  it('folds the rate and monthly columns away on small screens', () => {
    // Annual and the lifespan total survive — the two the copy quotes — so a
    // phone gets three columns instead of a horizontal scroll.
    render(<StorageCostCard {...base} />);
    expandAll();
    const rate = screen.getAllByRole('columnheader', { name: 'Rate /TB/mo' });
    const monthly = screen.getAllByRole('columnheader', { name: 'Monthly' });
    const annual = screen.getAllByRole('columnheader', { name: 'Annual' });
    expect(rate[0].className).toMatch(/hidden.*md:table-cell/);
    expect(monthly[0].className).toMatch(/hidden.*sm:table-cell/);
    expect(annual[0].className).not.toMatch(/hidden/);
  });

  it('totals each provider over the configured hardware lifespan', () => {
    const { container } = render(<StorageCostCard {...base} />);
    expandAll();
    expect(screen.getAllByText('5 years')).toHaveLength(2);
    // User quota over 5 years: S3 $65,340, B2 $15,012, here $2,376.
    expect(container.textContent).toMatch(/\$65,340/);
    expect(container.textContent).toMatch(/\$15,012/);
    expect(container.textContent).toMatch(/\$2,376/);
    // Cluster over 5 years: S3 $219,060, here $7,920.
    expect(container.textContent).toMatch(/\$219,060/);
    expect(container.textContent).toMatch(/\$7,920/);
  });

  it('makes the cluster’s lifespan total equal the disks it bought', () => {
    // 36 TB usable at RF 3 is 108 raw TB; 108 × $22 = $2,376. A lifespan of
    // amortized capital is the capital — the check an operator does by hand.
    const { container } = render(<StorageCostCard {...base} />);
    expandAll();
    expect(container.textContent).toMatch(/\$2,376/);
    expect(36 * 3 * 22).toBe(2376);
  });

  it('labels the horizon column from the configured lifespan', () => {
    render(
      <StorageCostCard
        {...base}
        pricing={{ garageUsdPerTb: 22, hardwareLifespanYears: 3 }}
      />
    );
    expandAll();
    expect(screen.getAllByText('3 years')).toHaveLength(2);
  });

  it('puts the two comparisons side by side once there is room', () => {
    const { container } = render(<StorageCostCard {...base} />);
    const grid = container.querySelector('.gap-8')!;
    expect(grid.className).toMatch(/xl:grid-cols-2/);
    // Stacked below that: no unprefixed grid-cols, so the default is one column.
    expect(grid.className).not.toMatch(/(^|\s)grid-cols-2/);
  });

  it('does not half-width a lone section', () => {
    // A single table with dead space beside it reads as a rendering fault.
    const { container } = render(
      <StorageCostCard {...base} clusterUsableBytes={0} />
    );
    expect(container.querySelector('.gap-8')!.className).not.toMatch(
      /xl:grid-cols-2/
    );
  });

  it('captions each section with what is being priced', () => {
    const { container } = render(<StorageCostCard {...base} />);
    expect(container.textContent).toMatch(/36 TB quota/);
    expect(container.textContent).toMatch(
      /120 TB usable, after 3× replication/
    );
  });

  it('prices the user’s 36 TB quota including egress', () => {
    // S3 is $828 storage + $261 egress a month = $13,068 a year.
    const { container } = render(<StorageCostCard {...base} />);
    expandAll();
    expect(container.textContent).toMatch(/\$13,068/);
    expect(container.textContent).toMatch(/\$3,002/);
    expect(container.textContent).toMatch(/\$475\.20/);
    expect(container.textContent).toMatch(/\$12,593/);
  });

  it('prices the whole cluster — 120 TB usable is 360 TB of disk', () => {
    // 360 raw TB × $22 = $7,920 of capital, over 5 years = $1,584 a year.
    const { container } = render(<StorageCostCard {...base} />);
    expandAll();
    expect(container.textContent).toMatch(/\$43,812/);
    expect(container.textContent).toMatch(/\$10,008/);
    expect(container.textContent).toMatch(/\$1,584/);
    expect(container.textContent).toMatch(/\$42,228/);
  });

  it('shows each rate as a plain dollar figure per TB per month', () => {
    // The whole point of pricing per TB: every rate lands in readable dollars
    // instead of the sub-cent GB figures that needed their own formatter.
    const { container } = render(<StorageCostCard {...base} />);
    expandAll();
    expect(screen.getAllByText('Rate /TB/mo')).toHaveLength(2);
    expect(container.textContent).toMatch(/\$23\.00/);
    expect(container.textContent).toMatch(/\$6\.95/);
    expect(container.textContent).toMatch(/\$1\.10/);
  });

  it('names only the two bracketing providers', () => {
    // Naming a company is fine; naming one beside an invented number is not.
    // Guards against reintroducing a fabricated "blended cloud" row.
    const { container } = render(<StorageCostCard {...base} />);
    expandAll();
    expect(screen.getAllByText('Amazon S3')).toHaveLength(2);
    expect(screen.getAllByText('Backblaze B2')).toHaveLength(2);
    expect(container.textContent).not.toMatch(/Wasabi/);
  });

  it('states the egress assumption and the replication factor in visible copy', () => {
    // Drop the RF and the cluster looks 3x cheaper than it is; omit the egress
    // assumption and the S3 figure looks unexplained. Both belong on screen.
    const { container } = render(<StorageCostCard {...base} />);
    expect(container.textContent).toMatch(/read back once a year/);
    expect(container.textContent).toMatch(/\$22\.00\/raw TB × 3 replicas/);
    expect(container.textContent).not.toMatch(/1 replicas/);
    expect(container.textContent).toMatch(/over 5 years/);
    expect(container.textContent).toMatch(
      /excluding power, network and operator time/
    );
  });

  it('shows when the rates were checked, so they cannot silently age', () => {
    const { container } = render(<StorageCostCard {...base} />);
    expect(container.textContent).toMatch(/Provider rates as of August 2026/);
  });

  it('prices the quota — granted plus gifted — not what has been written', () => {
    const { container } = render(<StorageCostCard {...base} />);
    // "Claim" is the ledger's internal term; it must not reach the user.
    expect(container.textContent).not.toMatch(/claim/i);
  });

  it('carries no call to action — it lives on the page it would link to', () => {
    const { container } = render(<StorageCostCard {...base} />);
    expect(container.querySelector('a')).toBeNull();
  });

  it('takes the cluster page’s panel treatment through className', () => {
    // No variant of its own: the cluster page passes the same constant its
    // event timeline uses, so the two panels match by construction.
    const { container } = render(
      <StorageCostCard {...base} className={CLUSTER_PANEL_CLASS} />
    );
    const card = container.querySelector('[data-slot=card]')!;
    expect(card.className).toContain(CLUSTER_PANEL_CLASS);
  });

  it('still prices the cluster for a user with no quota of their own', () => {
    const { container } = render(<StorageCostCard {...base} quotaBytes={0} />);
    expandAll();
    expect(container.textContent).toMatch(/no storage quota yet/i);
    expect(container.textContent).toMatch(/\$1,584/);
    expect(container.querySelectorAll('section')).toHaveLength(1);
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('omits the cluster section entirely when the layout has not loaded', () => {
    const { container } = render(
      <StorageCostCard {...base} clusterUsableBytes={0} />
    );
    expect(container.querySelectorAll('section')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'This cluster' })).toBeNull();
  });

  it('scales the cluster hardware cost with the replication factor', () => {
    // At RF 1 the same 120 TB usable is only 120 TB of disk: a third the cost.
    const { container } = render(
      <StorageCostCard {...base} replicationFactor={1} />
    );
    expandAll();
    expect(container.textContent).toMatch(/\$528\.00/);
    // ...and the 5-year total is the disks: 120 raw TB × $22 = $2,640.
    expect(container.textContent).toMatch(/\$2,640/);
  });
});
