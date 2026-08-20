import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { StagedChangesTable } from './staged-changes-table';
import {
  EMPTY_STAGED_COPY,
  UNRECOGNISED_CHANGE_COPY,
} from '@/lib/cluster/staging-copy';

const KEY_A = 'aaaa000000000001';
const KEY_B = 'bbbb000000000002';
const TB = 1_000_000_000_000;

const ROLES = [
  { id: KEY_A, zone: 'dc1', capacity: 16 * TB, tags: ['ssd', 'name:vault-01'] },
  { id: KEY_B, zone: 'dc2', capacity: 8 * TB, tags: [] },
];

describe('StagedChangesTable', () => {
  it('says plainly when nothing is staged', () => {
    const { container } = render(
      <StagedChangesTable roles={ROLES} staged={[]} />
    );
    expect(container.textContent).toContain(EMPTY_STAGED_COPY);
  });

  it('renders an assign as a before → after', () => {
    const { container } = render(
      <StagedChangesTable
        roles={ROLES}
        staged={[{ id: KEY_A, zone: 'dc3', capacity: 32 * TB, tags: ['ssd'] }]}
      />
    );

    expect(container.textContent).toContain('vault-01');
    expect(container.textContent).toContain('Assign');
    expect(container.textContent).toContain('dc1');
    expect(container.textContent).toContain('dc3');
    expect(container.textContent).toContain('16 TB');
    expect(container.textContent).toContain('32 TB');
  });

  it('renders a removal', () => {
    const { container } = render(
      <StagedChangesTable
        roles={ROLES}
        staged={[{ id: KEY_B, remove: true }]}
      />
    );

    expect(container.textContent).toContain('Remove');
    expect(container.textContent).toContain('Removed from the layout');
  });

  it('calls a gateway a gateway rather than an unknown capacity', () => {
    const { container } = render(
      <StagedChangesTable
        roles={ROLES}
        staged={[{ id: KEY_A, zone: 'dc1', capacity: null, tags: [] }]}
      />
    );

    expect(container.textContent).toContain('gateway');
  });

  it('shows a change it cannot read instead of hiding it', () => {
    // `garage layout apply` would commit this one too.
    const { container } = render(
      <StagedChangesTable roles={ROLES} staged={[{ id: KEY_A }]} />
    );

    expect(container.textContent).toContain('Unrecognised');
    expect(container.textContent).toContain(UNRECOGNISED_CHANGE_COPY);
    expect(container.textContent).not.toContain(EMPTY_STAGED_COPY);
  });

  it('marks a node that has no role yet', () => {
    const { container } = render(
      <StagedChangesTable
        roles={ROLES}
        staged={[
          { id: 'cccc000000000003', zone: 'dc1', capacity: TB, tags: [] },
        ]}
      />
    );

    expect(container.textContent).toContain('no role yet');
  });
});
