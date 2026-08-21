import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LastScrub } from './last-scrub';
import type { ScrubFreshness } from '@/lib/repair/scrub-freshness';

/**
 * Six kinds, six distinct readings. The assertion that matters is the last one:
 * "a scrub is running", "Garage said something we don't understand" and "no
 * date was reported" must not render as the same sentence, because the whole
 * reason `scrub-status.ts` distinguishes them is that collapsing them is a
 * silent all-clear.
 */

const kinds: ScrubFreshness[] = [
  {
    kind: 'completed',
    iso: '2026-08-17T03:00:00Z',
    ageDays: 3,
    relative: '3 days ago',
  },
  { kind: 'in-progress' },
  { kind: 'no-date' },
  { kind: 'unrecognised' },
  { kind: 'no-worker' },
  { kind: 'node-error', message: 'unreachable' },
];

describe('LastScrub', () => {
  it('renders a completed scrub with its relative age', () => {
    render(<LastScrub freshness={kinds[0]} />);
    expect(screen.getByText('3 days ago')).toBeInTheDocument();
  });

  it('flags a stale scrub in amber, not red', () => {
    render(
      <LastScrub
        freshness={{
          kind: 'completed',
          iso: '2026-01-01T00:00:00Z',
          ageDays: 200,
          relative: '200 days ago',
        }}
      />
    );
    const age = screen.getByText('200 days ago');
    expect(age.className).toContain('amber');
    // An overdue scrub is a thing to look into, not a fault.
    expect(age.className).not.toContain('destructive');
  });

  it('gives every kind its own words', () => {
    const rendered = kinds.map((freshness) => {
      const { container, unmount } = render(
        <LastScrub freshness={freshness} />
      );
      const text = container.textContent ?? '';
      unmount();
      return text;
    });

    expect(new Set(rendered).size).toBe(kinds.length);
  });

  it('never renders in-progress or unrecognised as "no date"', () => {
    for (const freshness of [
      { kind: 'in-progress' } as const,
      { kind: 'unrecognised' } as const,
    ]) {
      const { container, unmount } = render(
        <LastScrub freshness={freshness} />
      );
      expect(container.textContent).not.toContain('No date reported');
      unmount();
    }
  });

  it('appends the next scheduled pass when Garage reported one', () => {
    render(
      <LastScrub freshness={kinds[1]} nextScheduledAt="2026-09-01T00:00:00Z" />
    );
    expect(screen.getByText(/^next /)).toBeInTheDocument();
  });
});
