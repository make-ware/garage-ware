import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BucketTable } from './bucket-table';
import { BucketMetrics } from './bucket-metrics';
import { GIBIBYTE } from '@/lib/storage/units';
import type { BucketWithUsage } from '@/lib/types';

function bucket(partial: Partial<BucketWithUsage>): BucketWithUsage {
  return {
    id: partial.name ?? 'id',
    user: 'u1',
    garage_bucket_id: `garage-${partial.name ?? 'id'}-0123456789abcdef`,
    name: 'bucket',
    quota_gb: 0,
    created: '',
    updated: '',
    ...partial,
  } as BucketWithUsage;
}

/** Row order as rendered, by bucket name (header row excluded). */
function rowNames(): string[] {
  const [, ...rows] = screen.getAllByRole('row');
  return rows.map((row) => within(row).getAllByRole('cell')[0].textContent!);
}

describe('BucketTable', () => {
  const buckets = [
    // 95% full: 9.5 GiB of a 10 GiB quota.
    bucket({ name: 'alpha', quota_gb: 10, bytes: 9.5 * GIBIBYTE, objects: 5 }),
    // 10% full but far larger in absolute terms.
    bucket({ name: 'beta', quota_gb: 100, bytes: 10 * GIBIBYTE, objects: 90 }),
    // Uncapped: no fill to speak of.
    bucket({ name: 'gamma', quota_gb: 0, bytes: 1 * GIBIBYTE, objects: 1 }),
  ];

  it('never shows the Garage bucket id', () => {
    render(<BucketTable buckets={buckets} />);
    expect(screen.queryByText(/garage-alpha/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Garage ID/)).not.toBeInTheDocument();
  });

  it('sorts by name ascending out of the box', () => {
    render(<BucketTable buckets={buckets} />);
    expect(rowNames()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('sorts the size column by fill percentage, not absolute bytes', () => {
    render(<BucketTable buckets={buckets} />);
    fireEvent.click(screen.getByRole('button', { name: /Size quota/ }));
    // beta holds ten times alpha's bytes, but alpha is the one about to run
    // out — and the uncapped bucket has no fill, so it sorts last either way.
    expect(rowNames()).toEqual(['beta', 'alpha', 'gamma']);

    fireEvent.click(screen.getByRole('button', { name: /Size quota/ }));
    expect(rowNames()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('sorts the used column by absolute bytes', () => {
    render(<BucketTable buckets={buckets} />);
    fireEvent.click(screen.getByRole('button', { name: /Used/ }));
    expect(rowNames()).toEqual(['gamma', 'alpha', 'beta']);
  });

  it('colour-codes the fill percentage past 90%', () => {
    render(<BucketTable buckets={buckets} />);
    expect(screen.getByText('(95%)')).toHaveClass('text-destructive');
    expect(screen.getByText('(10%)')).toHaveClass('text-muted-foreground');
  });

  it('renders the empty message rather than a headerless table', () => {
    render(<BucketTable buckets={[]} emptyMessage="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('BucketMetrics', () => {
  it('totals usage and counts the buckets that are nearly full', () => {
    render(
      <BucketMetrics
        buckets={[
          bucket({
            name: 'a',
            quota_gb: 10,
            bytes: 9.5 * GIBIBYTE,
            objects: 3,
          }),
          bucket({ name: 'b', quota_gb: 10, bytes: 1 * GIBIBYTE, objects: 7 }),
        ]}
        allocatedGb={20}
        grantedGb={50}
      />
    );
    expect(screen.getByText('1 over 90% full')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument(); // objects
    expect(screen.getByText(/of 53.69 GB granted/)).toBeInTheDocument();
  });

  it('counts a bucket that is near its object cap as nearly full', () => {
    render(
      <BucketMetrics
        buckets={[
          bucket({
            name: 'a',
            quota_gb: 100,
            bytes: 0,
            objects: 99,
            maxObjects: 100,
          }),
        ]}
        allocatedGb={100}
        grantedGb={100}
      />
    );
    expect(screen.getByText('1 over 90% full')).toBeInTheDocument();
  });

  it('takes allocated and granted from the caller rather than summing quotas', () => {
    // The authoritative figures come from /storage-summary — a bucket list that
    // disagrees with them must not win.
    render(
      <BucketMetrics
        buckets={[bucket({ name: 'a', quota_gb: 1 })]}
        allocatedGb={40}
        grantedGb={100}
      />
    );
    expect(screen.getByText(/of 107.37 GB granted/)).toBeInTheDocument();
    expect(screen.getByText(/64.42 GB free/)).toBeInTheDocument();
  });
});
