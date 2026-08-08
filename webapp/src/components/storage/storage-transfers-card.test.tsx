import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { StorageTransfersCard } from './storage-transfers-card';
import type { StorageInvite } from '@garage-ware/shared';
import type { LabelledTransfer } from '@/lib/types';

function transfer(partial: Partial<LabelledTransfer>): LabelledTransfer {
  return {
    id: partial.id ?? 't1',
    from_user: 'u1',
    to_user: 'u2',
    quota_gb: 100,
    created: '2026-07-02 10:00:00.000Z',
    updated: '',
    ...partial,
  } as LabelledTransfer;
}

function invite(partial: Partial<StorageInvite>): StorageInvite {
  return {
    id: partial.id ?? 'i1',
    from_user: 'u1',
    to_email: 'newcomer@example.com',
    quota_gb: 100,
    status: 'pending',
    created: '2026-08-01 10:00:00.000Z',
    updated: '',
    ...partial,
  } as StorageInvite;
}

const noop = async () => {};

function renderCard(
  props: Partial<React.ComponentProps<typeof StorageTransfersCard>> = {}
) {
  return render(
    <StorageTransfersCard
      received={[]}
      sent={[]}
      invites={[]}
      availableGb={1000}
      onTransfer={() => {}}
      onReturn={noop}
      onCancelInvite={noop}
      {...props}
    />
  );
}

describe('StorageTransfersCard', () => {
  it('names the counterparty by email, never by raw user id', () => {
    renderCard({
      received: [
        transfer({
          id: 'in1',
          from_user: 'abc123',
          from_email: 'alice@example.com',
        }),
      ],
      sent: [
        transfer({
          id: 'out1',
          to_user: 'def456',
          to_email: 'bob@example.com',
        }),
      ],
    });
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    expect(screen.queryByText(/abc123|def456/)).not.toBeInTheDocument();
  });

  it('offers Return on incoming transfers only — a sender cannot claw one back', () => {
    renderCard({
      received: [transfer({ id: 'in1', from_email: 'alice@example.com' })],
      sent: [transfer({ id: 'out1', to_email: 'bob@example.com' })],
    });
    expect(screen.getAllByRole('button', { name: 'Return' })).toHaveLength(1);
  });

  it('nets pending invites off the capacity it advertises', () => {
    // 1000 granted-and-free, 300 already promised to someone who has not
    // signed up: only 700 can actually be sent, and the server agrees.
    renderCard({
      availableGb: 1000,
      invites: [invite({ id: 'i1', quota_gb: 300 })],
    });
    expect(screen.getByText(/751.61 GB/)).toBeInTheDocument();
    expect(screen.getByText(/322.12 GB promised/)).toBeInTheDocument();
  });

  it('disables the CTA when everything free is already promised', () => {
    renderCard({
      availableGb: 300,
      invites: [invite({ id: 'i1', quota_gb: 300 })],
    });
    expect(
      screen.getByRole('button', { name: /Transfer or invite/ })
    ).toBeDisabled();
  });

  it('surfaces why an invite failed rather than dropping it silently', () => {
    renderCard({
      invites: [
        invite({
          id: 'i2',
          status: 'failed',
          to_email: 'lapsed@example.com',
          failure_reason: 'The sender no longer has 966.36 GB free.',
        }),
      ],
    });
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(
      screen.getByText(/The sender no longer has 966.36 GB free/)
    ).toBeInTheDocument();
  });

  it('hides claimed invites — the transfer they became is already listed', () => {
    renderCard({
      received: [transfer({ id: 'in1', from_email: 'alice@example.com' })],
      invites: [
        invite({
          id: 'i3',
          status: 'claimed',
          to_email: 'claimed@example.com',
        }),
      ],
    });
    expect(screen.queryByText('claimed@example.com')).not.toBeInTheDocument();
  });

  it('leaves access keys to their own card — this one is about people', () => {
    renderCard();
    expect(
      screen.queryByRole('link', { name: /Manage keys/ })
    ).not.toBeInTheDocument();
  });

  it('explains the empty state instead of showing bare headings', () => {
    renderCard();
    expect(screen.getByText(/No transfers yet/)).toBeInTheDocument();
    expect(screen.queryByText('Incoming')).not.toBeInTheDocument();
    expect(screen.queryByText('Outgoing')).not.toBeInTheDocument();
  });

  it('groups rows under the direction they travelled', () => {
    renderCard({
      received: [
        transfer({ id: 'in1', from_email: 'alice@example.com', quota_gb: 500 }),
      ],
      sent: [
        transfer({ id: 'out1', to_email: 'bob@example.com', quota_gb: 200 }),
      ],
    });
    const incoming = screen
      .getByText('Incoming')
      .closest('div')!.parentElement!;
    expect(within(incoming).getByText('alice@example.com')).toBeInTheDocument();
    expect(
      within(incoming).queryByText('bob@example.com')
    ).not.toBeInTheDocument();
  });

  it('shows a loading state rather than an empty-state lie', () => {
    renderCard({ loading: true });
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText(/No transfers yet/)).not.toBeInTheDocument();
  });

  it('asks before returning, quoting the amount and the sender', async () => {
    const onReturn = vi.fn(async () => {});
    renderCard({
      received: [
        transfer({ id: 'in1', from_email: 'alice@example.com', quota_gb: 500 }),
      ],
      onReturn,
    });
    screen.getByRole('button', { name: 'Return' }).click();
    expect(
      await screen.findByText(/returns 536.87 GB to alice@example.com/)
    ).toBeInTheDocument();
    expect(onReturn).not.toHaveBeenCalled();
  });
});
