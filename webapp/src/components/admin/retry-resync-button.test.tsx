import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RetryResyncButton } from './retry-resync-button';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ api: mocks.api }));
vi.mock('sonner', () => ({
  toast: { success: mocks.success, warning: mocks.warning, error: vi.fn() },
}));

const KEY_A = 'aaaa000000000001';

function renderButton(onDone = vi.fn()) {
  render(
    <RetryResyncButton
      nodeId={KEY_A}
      nodeLabel="vault-01"
      errorCount={12}
      onDone={onDone}
    />
  );
  return onDone;
}

/** Open the dialog, type the node name, and press the confirm button. */
function confirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Retry resync' }));
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'vault-01' },
  });
  const button = screen
    .getAllByRole('button', { name: 'Retry resync' })
    .find((b) => b.closest('[role="alertdialog"]'));
  fireEvent.click(button as HTMLElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockResolvedValue({
    ok: true,
    nodeId: KEY_A,
    count: 41_233,
    logged: true,
  });
});

describe('RetryResyncButton', () => {
  it('demands the node name before it will do anything', () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Retry resync' }));

    const button = screen
      .getAllByRole('button', { name: 'Retry resync' })
      .find((b) => b.closest('[role="alertdialog"]'));
    expect(button).toBeDisabled();

    // A neighbour's name must not pass: the question is "did you mean *this*
    // node".
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'vault-02' },
    });
    expect(button).toBeDisabled();
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('POSTs the node key with all:true and no action parameter', async () => {
    renderButton();
    confirm();

    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        '/next-api/garage/repairs/block-errors',
        { method: 'POST', body: { nodeId: KEY_A, all: true } }
      )
    );
    // The path is the operation. There is no enum here to smuggle anything into.
    expect(mocks.api.mock.calls[0][1].body).not.toHaveProperty('action');
  });

  it('reports the count as queued, not as repaired', async () => {
    const onDone = renderButton();
    confirm();

    await waitFor(() => expect(mocks.success).toHaveBeenCalled());
    // Garage has re-queued them; whether they can be fetched is the next
    // attempt's answer, not this one's.
    expect(mocks.success.mock.calls[0][0]).toContain('41,233');
    expect(mocks.success.mock.calls[0][0]).toContain('queued for resync');
    expect(onDone).toHaveBeenCalled();
  });

  it('warns, rather than reporting failure, when only the timeline row failed', async () => {
    mocks.api.mockResolvedValue({
      ok: true,
      nodeId: KEY_A,
      count: 3,
      logged: false,
    });
    renderButton();
    confirm();

    // The retry ran. An operator who reads "failed" will click again.
    await waitFor(() => expect(mocks.warning).toHaveBeenCalled());
    expect(mocks.warning.mock.calls[0][0]).toContain('timeline');
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
