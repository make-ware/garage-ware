import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PlannerCommands } from './planner-commands';

const COMMANDS = [
  'garage layout assign aaaa000000000001 -z dc1 -c 32TB',
  'garage layout show',
  'garage layout apply',
];

describe('PlannerCommands', () => {
  it('renders nothing when the plan changes nothing', () => {
    const { container } = render(<PlannerCommands commands={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('keeps the commands collapsed until asked for', () => {
    // The plan is the answer; the commands are how to act on it.
    const { container } = render(<PlannerCommands commands={COMMANDS} />);
    expect(container.textContent).not.toContain('garage layout assign');
    fireEvent.click(
      screen.getByRole('button', { name: 'Commands for this plan' })
    );
    expect(container.textContent).toContain(
      'garage layout assign aaaa000000000001 -z dc1 -c 32TB'
    );
  });
});
