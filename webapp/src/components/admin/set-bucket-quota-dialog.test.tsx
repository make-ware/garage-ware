import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SetBucketQuotaDialog } from './set-bucket-quota-dialog';
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

// The OTP step-up talks to PocketBase and sends a real email. The gate's own
// behaviour is not what these tests are about, so stand in a plain Dialog that
// renders the verified branch immediately — the children still need the Radix
// context that DialogTitle/DialogFooter read.
vi.mock('@/components/auth/otp-gated-dialog', async () => {
  const { Dialog, DialogContent } = await import('@/components/ui/dialog');
  return {
    OtpGatedDialog: ({ children }: { children: React.ReactNode }) => (
      <Dialog open>
        <DialogContent>{children}</DialogContent>
      </Dialog>
    ),
  };
});

function renderDialog(
  overrides: Partial<{
    currentGb: number;
    garageGb: number | null;
    ownerGrantedGb: number;
    ownerOtherAllocatedGb: number;
    onApplied: () => void;
  }> = {}
) {
  const onApplied = overrides.onApplied ?? vi.fn();
  render(
    <SetBucketQuotaDialog
      open
      onOpenChange={vi.fn()}
      bucketId="bucket-1"
      bucketName="my-bucket"
      ownerEmail="owner@example.com"
      currentGb={overrides.currentGb ?? tbToGib(1)}
      garageGb={overrides.garageGb === undefined ? null : overrides.garageGb}
      ownerGrantedGb={overrides.ownerGrantedGb ?? tbToGib(10)}
      ownerOtherAllocatedGb={overrides.ownerOtherAllocatedGb ?? 0}
      onApplied={onApplied}
    />
  );
  return { onApplied };
}

const quota = () => screen.getByLabelText('Quota') as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'Save quota' });

beforeEach(() => {
  api.mockReset().mockResolvedValue({});
  toastError.mockReset();
});

describe('SetBucketQuotaDialog', () => {
  it('seeds the input with the recorded quota', () => {
    renderDialog({ currentGb: tbToGib(1) });
    expect(quota().value).toBe('1');
  });

  it('PATCHes the bucket with the new quota', async () => {
    renderDialog({ currentGb: tbToGib(1) });
    fireEvent.change(quota(), { target: { value: '3' } });
    fireEvent.click(save());

    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledWith('/next-api/garage/buckets/bucket-1', {
      method: 'PATCH',
      body: { quota_gb: tbToGib(3) },
    });
  });

  it('refuses an unchanged quota rather than writing a no-op', () => {
    renderDialog({ currentGb: tbToGib(1) });
    expect(save()).toBeDisabled();
    expect(api).not.toHaveBeenCalled();
  });

  it('blocks a quota beyond the owner’s remaining grant', () => {
    // Validated against the OWNER's grant, not the acting admin's.
    renderDialog({
      currentGb: tbToGib(1),
      ownerGrantedGb: tbToGib(5),
      ownerOtherAllocatedGb: tbToGib(3),
    });
    fireEvent.change(quota(), { target: { value: '4' } });
    expect(
      screen.getByText(/exceeds what the owner has been granted/i)
    ).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('allows filling the owner’s remaining grant exactly', () => {
    renderDialog({
      currentGb: tbToGib(1),
      ownerGrantedGb: tbToGib(5),
      ownerOtherAllocatedGb: tbToGib(3),
    });
    fireEvent.change(quota(), { target: { value: '2' } });
    expect(save()).not.toBeDisabled();
  });

  it('blocks a negative quota', () => {
    renderDialog({ currentGb: tbToGib(1) });
    fireEvent.change(quota(), { target: { value: '-1' } });
    expect(save()).toBeDisabled();
  });

  it('surfaces the Garage value when it disagrees with ours', () => {
    renderDialog({ currentGb: tbToGib(1), garageGb: tbToGib(2) });
    expect(screen.getByText(/Garage currently enforces/i)).toBeInTheDocument();
  });

  it('says nothing about Garage when the two agree', () => {
    renderDialog({ currentGb: tbToGib(1), garageGb: tbToGib(1) });
    expect(screen.queryByText(/Garage currently enforces/i)).toBeNull();
  });

  it('notifies the parent after a successful save', async () => {
    const onApplied = vi.fn();
    renderDialog({ currentGb: tbToGib(1), onApplied });
    fireEvent.change(quota(), { target: { value: '2' } });
    fireEvent.click(save());
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  });

  it('surfaces a server rejection and leaves the parent untouched', async () => {
    const onApplied = vi.fn();
    api.mockRejectedValueOnce(new Error('Quota exceeds granted storage'));
    renderDialog({ currentGb: tbToGib(1), onApplied });
    fireEvent.change(quota(), { target: { value: '2' } });
    fireEvent.click(save());

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Quota exceeds granted storage')
    );
    expect(onApplied).not.toHaveBeenCalled();
  });
});
