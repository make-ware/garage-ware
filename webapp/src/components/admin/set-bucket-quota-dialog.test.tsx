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

const SUMMARY_PREFIX = '/next-api/garage/storage-summary';

/** The PATCH the dialog fires on save, ignoring its own grant lookup. */
function patchCalls() {
  return api.mock.calls.filter(
    ([url]) => typeof url === 'string' && !url.startsWith(SUMMARY_PREFIX)
  );
}

interface Options {
  currentGb?: number;
  garageGb?: number | null;
  /** The owner's net grant, as `/storage-summary` reports it. */
  ownerGrantedGb?: number;
  /** What the owner's OTHER buckets reserve; this bucket's own quota is added. */
  ownerOtherAllocatedGb?: number;
  /** Make the grant lookup fail, as it would if Garage were unreachable. */
  summaryFails?: boolean;
  /** Leave the grant lookup pending, to observe the loading state. */
  summaryPending?: boolean;
  onApplied?: () => void;
  patchRejectsWith?: Error;
}

function renderDialog(overrides: Options = {}) {
  const currentGb = overrides.currentGb ?? tbToGib(1);
  const grantedGb = overrides.ownerGrantedGb ?? tbToGib(10);
  const otherAllocatedGb = overrides.ownerOtherAllocatedGb ?? 0;
  const onApplied = overrides.onApplied ?? vi.fn();

  api.mockImplementation((url: unknown) => {
    if (typeof url === 'string' && url.startsWith(SUMMARY_PREFIX)) {
      if (overrides.summaryPending) return new Promise(() => {});
      if (overrides.summaryFails) {
        return Promise.reject(new Error('Garage unreachable'));
      }
      return Promise.resolve({
        netGrantedGb: grantedGb,
        // The dialog subtracts this bucket's own quota back out, so the figure
        // it should end up displaying is `otherAllocatedGb`.
        allocatedGb: otherAllocatedGb + currentGb,
      });
    }
    if (overrides.patchRejectsWith) {
      return Promise.reject(overrides.patchRejectsWith);
    }
    return Promise.resolve({});
  });

  render(
    <SetBucketQuotaDialog
      open
      onOpenChange={vi.fn()}
      bucketId="bucket-1"
      bucketName="my-bucket"
      ownerEmail="owner@example.com"
      currentGb={currentGb}
      garageGb={overrides.garageGb === undefined ? null : overrides.garageGb}
      ownerId="owner-1"
      onApplied={onApplied}
    />
  );
  return { onApplied };
}

/** Wait for the owner's position to land before asserting on grant maths. */
async function grantLoaded() {
  await screen.findByText(/Owner grant:/i);
}

const quota = () => screen.getByLabelText('Quota') as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'Save quota' });

beforeEach(() => {
  api.mockReset();
  toastError.mockReset();
});

describe('SetBucketQuotaDialog', () => {
  it('seeds the input with the recorded quota', () => {
    renderDialog({ currentGb: tbToGib(1) });
    expect(quota().value).toBe('1');
  });

  it('PATCHes the bucket with the new quota', async () => {
    renderDialog({ currentGb: tbToGib(1) });
    await grantLoaded();
    fireEvent.change(quota(), { target: { value: '3' } });
    fireEvent.click(save());

    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(patchCalls()[0]).toEqual([
      '/next-api/garage/buckets/bucket-1',
      { method: 'PATCH', body: { quota_gb: tbToGib(3) } },
    ]);
  });

  it('refuses an unchanged quota rather than writing a no-op', async () => {
    renderDialog({ currentGb: tbToGib(1) });
    await grantLoaded();
    expect(save()).toBeDisabled();
    expect(patchCalls()).toHaveLength(0);
  });

  it('reads the owner’s position by id rather than trusting a caller-supplied number', async () => {
    // Regression: the grant used to arrive as a prop sourced from a single
    // 200-row page of /next-api/garage/users, so any owner past that page came
    // through as 0 and the dialog rejected every quota as over-grant.
    renderDialog({ ownerGrantedGb: tbToGib(5) });
    await grantLoaded();
    expect(api).toHaveBeenCalledWith(`${SUMMARY_PREFIX}?userId=owner-1`);
  });

  it('blocks a quota beyond the owner’s remaining grant', async () => {
    // Validated against the OWNER's grant, not the acting admin's.
    renderDialog({
      currentGb: tbToGib(1),
      ownerGrantedGb: tbToGib(5),
      ownerOtherAllocatedGb: tbToGib(3),
    });
    await grantLoaded();
    fireEvent.change(quota(), { target: { value: '4' } });
    expect(
      screen.getByText(/exceeds what the owner has been granted/i)
    ).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('allows filling the owner’s remaining grant exactly', async () => {
    renderDialog({
      currentGb: tbToGib(1),
      ownerGrantedGb: tbToGib(5),
      ownerOtherAllocatedGb: tbToGib(3),
    });
    await grantLoaded();
    fireEvent.change(quota(), { target: { value: '2' } });
    expect(save()).not.toBeDisabled();
  });

  it('does not block on a grant it could not read', async () => {
    // An unreadable grant must fall through to the server's own check. Blocking
    // here would be the same dead end as reading the grant as zero.
    renderDialog({ currentGb: tbToGib(1), summaryFails: true });
    await screen.findByText(/Owner grant unavailable/i);
    fireEvent.change(quota(), { target: { value: '999' } });
    expect(save()).not.toBeDisabled();
    expect(
      screen.queryByText(/exceeds what the owner has been granted/i)
    ).toBeNull();
  });

  it('says it is still checking while the grant is in flight', () => {
    renderDialog({ currentGb: tbToGib(1), summaryPending: true });
    expect(screen.getByText(/Checking the owner/i)).toBeInTheDocument();
  });

  it('blocks a negative quota', async () => {
    renderDialog({ currentGb: tbToGib(1) });
    await grantLoaded();
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
    await grantLoaded();
    fireEvent.change(quota(), { target: { value: '2' } });
    fireEvent.click(save());
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  });

  it('surfaces a server rejection and leaves the parent untouched', async () => {
    const onApplied = vi.fn();
    renderDialog({
      currentGb: tbToGib(1),
      onApplied,
      patchRejectsWith: new Error('Quota exceeds granted storage'),
    });
    await grantLoaded();
    fireEvent.change(quota(), { target: { value: '2' } });
    fireEvent.click(save());

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Quota exceeds granted storage')
    );
    expect(onApplied).not.toHaveBeenCalled();
  });
});
