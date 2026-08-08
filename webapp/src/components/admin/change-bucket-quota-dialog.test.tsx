import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChangeBucketQuotaDialog } from './change-bucket-quota-dialog';
import { MEGABYTE } from '@/lib/storage/units';

const api = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: (...args: unknown[]) => api(...args),
}));

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

// No OTP mock needed — this dialog is gated by a name challenge, so there is no
// PocketBase round trip to stand in for.

const SUMMARY_PREFIX = '/next-api/garage/storage-summary';

/** The PATCH the dialog fires on save, ignoring its own grant lookup. */
function patchCalls() {
  return api.mock.calls.filter(
    ([url]) => typeof url === 'string' && !url.startsWith(SUMMARY_PREFIX)
  );
}

interface Options {
  currentGb?: number;
  currentObjectQuota?: number;
  garageGb?: number | null;
  garageMaxObjects?: number | null;
  avgObjectSizeBytes?: number | null;
  grantedGb?: number;
  allocatedGb?: number;
  grantFails?: boolean;
}

const onApplied = vi.fn();

function renderDialog(opts: Options = {}) {
  const {
    currentGb = 10,
    currentObjectQuota = 0,
    garageGb = 10,
    garageMaxObjects = 0,
    avgObjectSizeBytes = null,
    grantedGb = 100,
    allocatedGb = 10,
    grantFails = false,
  } = opts;

  api.mockImplementation(async (url: string) => {
    if (url.startsWith(SUMMARY_PREFIX)) {
      if (grantFails) throw new Error('nope');
      return { netGrantedGb: grantedGb, allocatedGb };
    }
    return { record: {} };
  });

  return render(
    <ChangeBucketQuotaDialog
      open
      onOpenChange={vi.fn()}
      bucketId="bucket-1"
      bucketName="my-bucket"
      ownerEmail="owner@example.com"
      ownerId="user-1"
      currentGb={currentGb}
      garageGb={garageGb}
      currentObjectQuota={currentObjectQuota}
      garageMaxObjects={garageMaxObjects}
      avgObjectSizeBytes={avgObjectSizeBytes}
      onApplied={onApplied}
    />
  );
}

function save() {
  return screen.getByRole('button', { name: /save quota/i });
}

function confirmName(name = 'my-bucket') {
  fireEvent.change(screen.getByLabelText(/to confirm/i), {
    target: { value: name },
  });
}

function setObjects(value: string) {
  fireEvent.change(screen.getByLabelText(/object quota/i), {
    target: { value },
  });
}

beforeEach(() => {
  api.mockReset();
  toastError.mockReset();
  onApplied.mockReset();
});

describe('ChangeBucketQuotaDialog', () => {
  it('stays disabled until the bucket name is typed exactly', async () => {
    renderDialog();
    setObjects('500');
    expect(save()).toBeDisabled();

    confirmName('my-bucke');
    expect(save()).toBeDisabled();

    confirmName();
    await waitFor(() => expect(save()).toBeEnabled());
  });

  it('rejects a name that differs only in case', () => {
    renderDialog();
    setObjects('500');
    confirmName('My-Bucket');
    expect(save()).toBeDisabled();
  });

  it('stays disabled when nothing changed, even with the name typed', () => {
    renderDialog();
    confirmName();
    expect(save()).toBeDisabled();
  });

  it('sends only the object axis on an object-only edit', async () => {
    renderDialog({ currentGb: 10, currentObjectQuota: 0 });
    setObjects('500');
    confirmName();
    fireEvent.click(save());

    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    const [url, init] = patchCalls()[0];
    expect(url).toBe('/next-api/garage/buckets/bucket-1');
    expect(init).toMatchObject({ method: 'PATCH' });
    // No quota_gb: that is what lets the handler skip the grant check.
    expect((init as { body: Record<string, unknown> }).body).toEqual({
      object_quota: 500,
    });
  });

  it('sends both axes when both changed', async () => {
    // StorageQuotaInput displays decimal TB, so "1" is ~931 GiB — the grant has
    // to comfortably clear that or the form blocks as an over-grant.
    renderDialog({ currentGb: 10, currentObjectQuota: 0, grantedGb: 5000 });
    setObjects('500');
    fireEvent.change(screen.getByLabelText(/size quota/i), {
      target: { value: '1' },
    });
    confirmName();
    await waitFor(() => expect(save()).toBeEnabled());
    fireEvent.click(save());

    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    const body = (patchCalls()[0][1] as { body: Record<string, unknown> }).body;
    expect(body).toHaveProperty('object_quota', 500);
    expect(body).toHaveProperty('quota_gb');
  });

  it('blocks an over-grant on the size axis', async () => {
    renderDialog({ currentGb: 10, grantedGb: 20, allocatedGb: 10 });
    // 1 TB ≈ 931 GiB, far beyond a 20 GiB grant.
    fireEvent.change(screen.getByLabelText(/size quota/i), {
      target: { value: '1' },
    });
    confirmName();
    await waitFor(() => expect(save()).toBeDisabled());
    expect(
      screen.getByText(/exceeds what the owner has been granted/i)
    ).toBeInTheDocument();
  });

  it('does not let a large object count block the form', async () => {
    // Object caps are not drawn from the storage claim.
    renderDialog({ currentGb: 10, grantedGb: 20, allocatedGb: 10 });
    setObjects('999999999');
    confirmName();
    await waitFor(() => expect(save()).toBeEnabled());
  });

  it('does not block when the owner grant could not be read', async () => {
    renderDialog({ grantFails: true });
    setObjects('500');
    confirmName();
    await waitFor(() =>
      expect(screen.getByText(/owner grant unavailable/i)).toBeInTheDocument()
    );
    expect(save()).toBeEnabled();
  });

  it('rejects a fractional object count', () => {
    renderDialog();
    setObjects('10.5');
    confirmName();
    expect(save()).toBeDisabled();
    expect(screen.getByText(/whole number of objects/i)).toBeInTheDocument();
  });

  it('shows the derived cap and updates it with the size input', async () => {
    renderDialog({ currentGb: 0, avgObjectSizeBytes: MEGABYTE });
    fireEvent.change(screen.getByLabelText(/size quota/i), {
      target: { value: '1' },
    });
    // 1 TB in GiB, over a 1 MB average, derives a large but finite cap.
    await waitFor(() =>
      expect(screen.getByText(/derives a cap of/i)).toBeInTheDocument()
    );
  });

  it('labels an override as such, showing what would otherwise derive', async () => {
    renderDialog({ currentGb: 10, avgObjectSizeBytes: MEGABYTE });
    setObjects('500');
    await waitFor(() =>
      expect(screen.getByText(/would otherwise derive/i)).toBeInTheDocument()
    );
  });

  it('reports a server rejection and leaves onApplied untouched', async () => {
    renderDialog();
    api.mockImplementation(async (url: string) => {
      if (url.startsWith(SUMMARY_PREFIX)) {
        return { netGrantedGb: 100, allocatedGb: 10 };
      }
      throw new Error('Quota exceeds the user’s storage claim');
    });
    setObjects('500');
    confirmName();
    fireEvent.click(save());

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onApplied).not.toHaveBeenCalled();
  });
});
