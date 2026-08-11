import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SetClaimDialog } from './set-claim-dialog';
import { tbToGib } from '@/lib/storage/units';

const api = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: (...args: unknown[]) => api(...args),
}));

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
  },
}));

function renderDialog(
  overrides: Partial<{
    currentGb: number;
    nodeFreeGb: number;
    onApplied: () => void;
  }> = {}
) {
  const onApplied = overrides.onApplied ?? vi.fn();
  render(
    <SetClaimDialog
      open
      onOpenChange={vi.fn()}
      userId="user-1"
      userEmail="user@example.com"
      nodeId="node-a"
      nodeName="box1"
      currentGb={overrides.currentGb ?? tbToGib(4)}
      nodeFreeGb={overrides.nodeFreeGb ?? tbToGib(10)}
      onApplied={onApplied}
    />
  );
  return { onApplied };
}

function target(): HTMLInputElement {
  return screen.getByLabelText('New total') as HTMLInputElement;
}

function apply() {
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
}

beforeEach(() => {
  api.mockReset().mockResolvedValue({});
  toastError.mockReset();
});

describe('SetClaimDialog', () => {
  it('seeds the input with the current claim', () => {
    renderDialog({ currentGb: tbToGib(4) });
    expect(target().value).toBe('4');
  });

  it('posts the difference when growing a claim', async () => {
    renderDialog({ currentGb: tbToGib(4) });
    fireEvent.change(target(), { target: { value: '8' } });
    apply();

    // The admin typed the new total; the ledger must receive the delta.
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledWith('/next-api/garage/claims', {
      method: 'POST',
      body: {
        user_id: 'user-1',
        node_id: 'node-a',
        quota_gb: tbToGib(4),
      },
    });
  });

  it('posts a negative delta when shrinking a claim', async () => {
    renderDialog({ currentGb: tbToGib(4) });
    fireEvent.change(target(), { target: { value: '1' } });
    apply();

    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    const body = api.mock.calls[0][1].body as { quota_gb: number };
    expect(body.quota_gb).toBeCloseTo(-tbToGib(3), 6);
  });

  it('includes a trimmed note when one is given', async () => {
    renderDialog({ currentGb: tbToGib(4) });
    fireEvent.change(target(), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Note (optional)'), {
      target: { value: '  upgraded to 8TB disk  ' },
    });
    apply();

    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    const body = api.mock.calls[0][1].body as { note?: string };
    expect(body.note).toBe('upgraded to 8TB disk');
  });

  it('refuses a zero delta instead of writing a no-op ledger row', () => {
    renderDialog({ currentGb: tbToGib(4) });
    // Untouched: the target still equals the current claim.
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(api).not.toHaveBeenCalled();
  });

  it('re-enables Apply once the total actually changes', () => {
    renderDialog({ currentGb: tbToGib(4) });
    fireEvent.change(target(), { target: { value: '6' } });
    expect(screen.getByRole('button', { name: 'Apply' })).not.toBeDisabled();
  });

  it('shows the signed delta as the admin types', () => {
    renderDialog({ currentGb: tbToGib(4) });
    fireEvent.change(target(), { target: { value: '6' } });
    expect(screen.getByTestId('set-claim-delta')).toHaveTextContent('+2 TB');

    fireEvent.change(target(), { target: { value: '3' } });
    expect(screen.getByTestId('set-claim-delta')).toHaveTextContent('-1 TB');
  });

  it('warns when the target exceeds what the node has left', () => {
    renderDialog({ currentGb: tbToGib(4), nodeFreeGb: tbToGib(1) });
    fireEvent.change(target(), { target: { value: '9' } });
    expect(
      screen.getByText(/more than the node has left to give/i)
    ).toBeInTheDocument();
  });

  it('blocks a target below zero', () => {
    renderDialog({ currentGb: tbToGib(4) });
    fireEvent.change(target(), { target: { value: '-1' } });
    expect(screen.getByText(/cannot go below zero/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('notifies the parent after a successful adjustment', async () => {
    const onApplied = vi.fn();
    renderDialog({ currentGb: tbToGib(4), onApplied });
    fireEvent.change(target(), { target: { value: '5' } });
    apply();

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  });

  it('surfaces a server rejection and leaves the parent untouched', async () => {
    const onApplied = vi.fn();
    api.mockRejectedValueOnce(
      new Error('Adjustment exceeds node usable capacity')
    );
    renderDialog({ currentGb: tbToGib(4), onApplied });
    fireEvent.change(target(), { target: { value: '5' } });
    apply();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Adjustment exceeds node usable capacity'
      )
    );
    expect(onApplied).not.toHaveBeenCalled();
  });
});
