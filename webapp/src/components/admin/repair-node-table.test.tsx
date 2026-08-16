import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RepairNodeTable } from './repair-node-table';
import type { RepairNodeRow } from '@/hooks/use-repair-data';
import type { RepairNodeWorkers } from '@/app/next-api/garage/repairs/workers/route';

vi.mock('@/lib/api-client', () => ({
  api: vi.fn(async () => ({ ok: true, logged: true })),
}));

function workers(over: Partial<RepairNodeWorkers> = {}): RepairNodeWorkers {
  return {
    nodeId: 'n1',
    error: null,
    workers: [],
    workerNames: [],
    scrub: null,
    busyCount: 0,
    erroredCount: 0,
    ...over,
  };
}

function row(over: Partial<RepairNodeRow> = {}): RepairNodeRow {
  return {
    nodeId: 'aaaa1111bbbb2222',
    name: 'vault-01',
    label: 'vault-01',
    zone: 'dc1',
    isUp: true,
    draining: false,
    workers: workers(),
    ...over,
  };
}

function renderTable(rows: RepairNodeRow[]) {
  return render(
    <RepairNodeTable
      action="blocks"
      rows={rows}
      describe={(label) => <p>repairs {label}</p>}
      onLaunched={async () => {}}
    />
  );
}

describe('RepairNodeTable', () => {
  it('renders a launch button per node', () => {
    renderTable([
      row(),
      row({ nodeId: 'n2', name: 'vault-02', label: 'vault-02' }),
    ]);
    expect(
      screen.getAllByRole('button', { name: 'Repair blocks' })
    ).toHaveLength(2);
  });

  // The gate asks "did you mean *this* node". A neighbour's name must not pass.
  it('demands the node label and rejects a neighbouring node name', () => {
    renderTable([row()]);
    fireEvent.click(screen.getByRole('button', { name: 'Repair blocks' }));

    const input = screen.getByRole('textbox');
    const confirm = screen
      .getAllByRole('button', { name: 'Repair blocks' })
      .find((b) => b.closest('[role="alertdialog"]'))!;

    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: 'vault-02' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: 'vault-01' } });
    expect(confirm).toBeEnabled();
  });

  // A launch is creative, not destructive. Spending a red button on "Repair
  // blocks" would devalue it everywhere it means deletion. (Asserted on the
  // variant's background, not the substring "destructive", which the base
  // Button class also carries for its aria-invalid ring.)
  it('does not render the destructive red button for a launch', () => {
    renderTable([row()]);
    fireEvent.click(screen.getByRole('button', { name: 'Repair blocks' }));
    const confirm = screen
      .getAllByRole('button', { name: 'Repair blocks' })
      .find((b) => b.closest('[role="alertdialog"]'))!;
    expect(confirm.className).toContain('bg-primary');
    expect(confirm.className).not.toContain('bg-destructive');
  });

  // Not knowing is not the same as nothing running.
  it('shows a per-node worker error instead of reading as idle', () => {
    renderTable([row({ workers: workers({ error: 'node is unreachable' }) })]);
    expect(screen.getByText('node is unreachable')).toBeInTheDocument();
    expect(screen.queryByText('idle')).not.toBeInTheDocument();
  });

  it('keeps the launch button enabled for a node whose worker read failed', () => {
    renderTable([row({ workers: workers({ error: 'node is unreachable' }) })]);
    expect(screen.getByRole('button', { name: 'Repair blocks' })).toBeEnabled();
  });

  it('flags a node with errored workers', () => {
    renderTable([row({ workers: workers({ busyCount: 3, erroredCount: 2 }) })]);
    expect(screen.getByText('3 busy')).toBeInTheDocument();
    expect(screen.getByText('2 errored')).toBeInTheDocument();
  });

  it('renders node status', () => {
    renderTable([row({ isUp: false })]);
    expect(screen.getByText('down')).toBeInTheDocument();
  });
});
