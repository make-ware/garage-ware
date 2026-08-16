import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { buildClaimBars, StorageClaimChart } from './storage-claim-chart';
import type { ClaimBarSegment } from './storage-claim-chart';

/** Segment widths keyed by segment, for asserting the drawn geometry. */
function widths(segments: ClaimBarSegment[]): Record<string, number> {
  return Object.fromEntries(segments.map((s) => [s.key, s.widthGb]));
}

function amounts(segments: ClaimBarSegment[]): Record<string, number> {
  return Object.fromEntries(segments.map((s) => [s.key, s.gb]));
}

describe('buildClaimBars', () => {
  it('stacks claims and received to the net grant when nothing was sent', () => {
    const { sources, scaleMax } = buildClaimBars({
      claimsGb: 4000,
      receivedGb: 1000,
      sentGb: 0,
      netGrantedGb: 5000,
      allocatedGb: 0,
      storedGb: 0,
    });
    expect(widths(sources)).toEqual({ claimed: 4000, received: 1000 });
    expect(scaleMax).toBe(5000);
  });

  it('carves the sent amount off the tail so the coloured run equals net granted', () => {
    // 4000 claimed + 1000 received − 500 sent = 4500 net granted.
    const { sources, scaleMax } = buildClaimBars({
      claimsGb: 4000,
      receivedGb: 1000,
      sentGb: 500,
      netGrantedGb: 4500,
      allocatedGb: 0,
      storedGb: 0,
    });
    // Drawn: the received segment gives up 500 to the grey tail...
    expect(widths(sources)).toEqual({
      claimed: 4000,
      received: 500,
      given: 500,
    });
    // ...but the legend still reports the true ledger figure.
    expect(amounts(sources).received).toBe(1000);
    // The two coloured segments measure exactly the net grant.
    expect(widths(sources).claimed + widths(sources).received).toBe(4500);
    // The scale spans the gross, so the grey tail has room to draw.
    expect(scaleMax).toBe(5000);
  });

  it('lets the deduction eat into claims when more was sent than received', () => {
    const { sources } = buildClaimBars({
      claimsGb: 1000,
      receivedGb: 200,
      sentGb: 700,
      netGrantedGb: 500,
      allocatedGb: 0,
      storedGb: 0,
    });
    expect(widths(sources)).toEqual({ claimed: 500, received: 0, given: 700 });
    expect(amounts(sources)).toEqual({
      claimed: 1000,
      received: 200,
      given: 700,
    });
  });

  it('splits the allocation row into stored, reserved and unallocated', () => {
    const { allocation } = buildClaimBars({
      claimsGb: 1000,
      receivedGb: 0,
      sentGb: 0,
      netGrantedGb: 1000,
      allocatedGb: 600,
      storedGb: 250,
    });
    expect(widths(allocation)).toEqual({
      stored: 250,
      reserved: 350,
      unallocated: 400,
    });
  });

  it('draws quotas that reserve more than the grant instead of clamping them', () => {
    // An admin clawing a claim back can leave buckets reserving more than the
    // user now holds — hiding that would hide the thing they must fix.
    const { allocation, scaleMax } = buildClaimBars({
      claimsGb: 500,
      receivedGb: 0,
      sentGb: 0,
      netGrantedGb: 500,
      allocatedGb: 800,
      storedGb: 100,
    });
    // The excess is carved off the tail of the allocation, not stacked on top
    // of it: 100 + 400 + 300 is the 800 allocated, drawn once.
    expect(widths(allocation)).toEqual({
      stored: 100,
      reserved: 400,
      'over-allocated': 300,
    });
    expect(scaleMax).toBe(800);
  });

  it('flags bytes stored past what the bucket quotas reserve', () => {
    const { allocation } = buildClaimBars({
      claimsGb: 1000,
      receivedGb: 0,
      sentGb: 0,
      netGrantedGb: 1000,
      allocatedGb: 200,
      storedGb: 260,
    });
    expect(widths(allocation)).toEqual({
      stored: 200,
      'over-quota': 60,
      unallocated: 800,
    });
  });

  it('reports drawn widths as the allocation legend values, so the row adds up', () => {
    // Row 1 has to state ledger truth even where the bar carves a segment
    // short; row 2 is entirely derived, so width and stated value never part
    // company and a reader can add the legend up.
    for (const input of [
      { allocatedGb: 2000, storedGb: 800, netGrantedGb: 4500 },
      { allocatedGb: 800, storedGb: 100, netGrantedGb: 500 },
      { allocatedGb: 200, storedGb: 260, netGrantedGb: 1000 },
      { allocatedGb: 800, storedGb: 900, netGrantedGb: 500 },
    ]) {
      const { allocation } = buildClaimBars({
        claimsGb: input.netGrantedGb,
        receivedGb: 0,
        sentGb: 0,
        ...input,
      });
      for (const segment of allocation) {
        expect(segment.gb).toBe(segment.widthGb);
      }
      // Everything but the free tail is the allocation, or the bytes spilling
      // past it — never more than one of those two things at a time.
      const drawn = allocation
        .filter((s) => s.key !== 'unallocated')
        .reduce((total, s) => total + s.widthGb, 0);
      expect(drawn).toBe(Math.max(input.allocatedGb, input.storedGb));
    }
  });

  it('never returns a zero scale to divide by', () => {
    const { scaleMax, sources, allocation } = buildClaimBars({
      claimsGb: 0,
      receivedGb: 0,
      sentGb: 0,
      netGrantedGb: 0,
      allocatedGb: 0,
      storedGb: 0,
    });
    expect(scaleMax).toBeGreaterThan(0);
    expect(sources).toEqual([]);
    expect(allocation).toEqual([]);
  });
});

describe('StorageClaimChart', () => {
  it('names and values every drawn segment, so colour is never the only channel', () => {
    render(
      <StorageClaimChart
        claimsGb={4000}
        receivedGb={1000}
        sentGb={500}
        netGrantedGb={4500}
        allocatedGb={2000}
        storedGb={800}
        bucketCount={3}
      />
    );
    // Sources: the legend reports the ledger, signed.
    expect(screen.getByText('Granted')).toBeInTheDocument();
    expect(screen.getByText('Gifted to you')).toBeInTheDocument();
    expect(screen.getByText('Given away')).toBeInTheDocument();
    expect(screen.getByText('+1.07 TB')).toBeInTheDocument();
    expect(screen.getByText('−536.87 GB')).toBeInTheDocument();
    // Allocation.
    expect(screen.getByText('Stored')).toBeInTheDocument();
    expect(screen.getByText('Reserved')).toBeInTheDocument();
    expect(screen.getByText('Unallocated')).toBeInTheDocument();
  });

  it('describes each bar for screen readers', () => {
    render(
      <StorageClaimChart
        claimsGb={1000}
        receivedGb={0}
        sentGb={0}
        netGrantedGb={1000}
        allocatedGb={400}
        storedGb={100}
      />
    );
    const bars = screen.getAllByRole('img');
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Sources of your storage')
    );
    expect(bars[1]).toHaveAttribute(
      'aria-label',
      expect.stringContaining('How your storage is used')
    );
  });

  it('tells a user with no grant what to do instead of drawing an empty bar', () => {
    render(
      <StorageClaimChart
        claimsGb={0}
        receivedGb={0}
        sentGb={0}
        netGrantedGb={0}
        allocatedGb={0}
        storedGb={0}
      />
    );
    expect(screen.getByText(/no storage yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
