import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StagingNextSteps } from './staging-next-steps';
import {
  APPLY_ONCE_WARNING,
  NO_UNSTAGE_NOTICE,
} from '@/lib/cluster/staging-copy';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('StagingNextSteps', () => {
  it('names the version apply will produce, not the current one', () => {
    // Getting this off by one is the difference between a command that works
    // and one Garage refuses — and the operator would blame the cluster.
    const { container } = render(<StagingNextSteps version={12} />);

    expect(container.textContent).toContain('garage layout apply --version 13');
    expect(container.textContent).toContain('garage layout show');
  });

  it('is expanded, not hidden behind a toggle', () => {
    // Unlike the planner's command block: here the command *is* the answer.
    const { container } = render(<StagingNextSteps version={0} />);
    expect(container.textContent).toContain('garage layout apply --version 1');
  });

  it('carries the apply-once warning', () => {
    const { container } = render(<StagingNextSteps version={4} />);
    expect(container.textContent).toContain(APPLY_ONCE_WARNING);
  });

  it('names revert as a manual escape hatch, outside the copy block', () => {
    render(<StagingNextSteps version={4} />);

    const block = document.querySelector('pre');
    expect(block?.textContent).not.toContain('revert');
    expect(document.body.textContent).toContain(NO_UNSTAGE_NOTICE);
    expect(document.body.textContent).toContain('garage layout revert');
  });

  it('copies exactly the two commands', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<StagingNextSteps version={12} />);
    screen.getByText('Copy commands').closest('button')?.click();

    expect(writeText).toHaveBeenCalledWith(
      'garage layout show\ngarage layout apply --version 13'
    );
  });
});
