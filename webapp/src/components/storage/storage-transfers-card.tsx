'use client';

import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Mail,
  Undo2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { formatPbDate, formatStorage } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { StorageInvite } from '@garage-ware/shared';
import type { LabelledTransfer } from '@/lib/types';

export interface StorageTransfersCardProps {
  /** Handoffs to this user, newest first. */
  received: LabelledTransfer[];
  /** Handoffs from this user, newest first. */
  sent: LabelledTransfer[];
  /** This user's invites, in every state. */
  invites: StorageInvite[];
  /** Capacity still free to give away, in GiB. */
  availableGb: number;
  onTransfer: () => void;
  onReturn: (transferId: string) => Promise<void>;
  onCancelInvite: (inviteId: string) => Promise<void>;
  loading?: boolean;
  className?: string;
}

/** Anything a row needs to render, from either collection. */
interface Row {
  id: string;
  counterparty: string;
  quotaGb: number;
  note?: string;
  created: string;
}

function TransferRow({
  row,
  action,
  children,
}: {
  row: Row;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex items-start justify-between gap-3 py-2 border-b last:border-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{row.counterparty}</p>
        <p className="text-xs text-muted-foreground">
          {formatPbDate(row.created)}
          {row.note ? ` — ${row.note}` : ''}
        </p>
        {children}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <span className="text-sm font-medium tabular-nums">
          {formatStorage(row.quotaGb)}
        </span>
        {action}
      </div>
    </li>
  );
}

/** A titled group of rows, rendered only when it has any. */
function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {icon}
          {title}
        </p>
        <span className="text-xs text-muted-foreground/70">{hint}</span>
      </div>
      <ul className="mt-1">{children}</ul>
    </div>
  );
}

const INVITE_BADGE: Record<
  string,
  { label: string; variant: 'secondary' | 'outline' | 'destructive' }
> = {
  pending: { label: 'Awaiting signup', variant: 'secondary' },
  claimed: { label: 'Claimed', variant: 'outline' },
  failed: { label: 'Failed', variant: 'destructive' },
};

/**
 * The counterpart to "Storage nodes": where capacity came from and went, by
 * person rather than by machine.
 *
 * Incoming and outgoing sit in one card because they are two directions of one
 * relationship, and a user reading "who owes me what" wants both at once. It
 * carries the transfer CTA, since the list is the natural place to act on it,
 * and nothing else — access keys have their own card at the top of the
 * dashboard, since they are unrelated to who handed whom capacity.
 *
 * Only the recipient may return a transfer (the sender cannot claw one back),
 * which is why the Return action appears on incoming rows only.
 */
export function StorageTransfersCard({
  received,
  sent,
  invites,
  availableGb,
  onTransfer,
  onReturn,
  onCancelInvite,
  loading,
  className,
}: StorageTransfersCardProps) {
  const pendingInvites = invites.filter((i) => i.status === 'pending');
  // Pending invites promise capacity without reserving it, and the server
  // subtracts them when it checks a send. Show the same figure here, or the
  // card would advertise more than the transfer dialog will let you give.
  const promisedGb = pendingInvites.reduce(
    (sum, i) => sum + (Number(i.quota_gb) || 0),
    0
  );
  const sendableGb = Math.max(availableGb - promisedGb, 0);
  // A settled invite has become a transfer (or failed); the transfer lists
  // already carry the claimed ones, so only failures are still worth showing.
  const failedInvites = invites.filter((i) => i.status === 'failed');
  const isEmpty =
    received.length === 0 &&
    sent.length === 0 &&
    pendingInvites.length === 0 &&
    failedInvites.length === 0;

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowLeftRight className="h-5 w-5" />
          Storage transfers
        </CardTitle>
        <CardDescription>
          Storage handed between you and other users —{' '}
          <strong>{formatStorage(sendableGb)}</strong> free to give
          {promisedGb > 0 && <>, {formatStorage(promisedGb)} promised</>}.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex-1 space-y-5">
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {!loading && isEmpty && (
          <p className="text-sm text-muted-foreground">
            No transfers yet. You can give part of your unallocated storage to
            anyone by email — they don&apos;t need an account first.
          </p>
        )}

        {received.length > 0 && (
          <Section
            icon={<ArrowDownLeft className="h-3.5 w-3.5" />}
            title="Incoming"
            hint="you can return these"
          >
            {received.map((t) => (
              <TransferRow
                key={t.id}
                row={{
                  id: t.id,
                  counterparty: t.from_email ?? 'Unknown sender',
                  quotaGb: t.quota_gb,
                  note: t.note,
                  created: t.created,
                }}
                action={
                  <ConfirmDeleteDialog
                    trigger={
                      <Button variant="ghost" size="sm" aria-label="Return">
                        <Undo2 className="h-4 w-4" />
                      </Button>
                    }
                    title="Return this transfer?"
                    description={`This returns ${formatStorage(t.quota_gb)} to ${t.from_email ?? 'the sender'}. It will fail if your bucket quotas no longer fit without it.`}
                    confirmText="return"
                    confirmLabel="Return"
                    onConfirm={() => onReturn(t.id)}
                  />
                }
              />
            ))}
          </Section>
        )}

        {sent.length > 0 && (
          <Section
            icon={<ArrowUpRight className="h-3.5 w-3.5" />}
            title="Outgoing"
            hint="only the recipient can return these"
          >
            {sent.map((t) => (
              <TransferRow
                key={t.id}
                row={{
                  id: t.id,
                  counterparty: t.to_email ?? 'Unknown recipient',
                  quotaGb: t.quota_gb,
                  note: t.note,
                  created: t.created,
                }}
              />
            ))}
          </Section>
        )}

        {(pendingInvites.length > 0 || failedInvites.length > 0) && (
          <Section
            icon={<Mail className="h-3.5 w-3.5" />}
            title="Invites"
            hint="sent to people without an account"
          >
            {[...pendingInvites, ...failedInvites].map((invite) => {
              const badge = INVITE_BADGE[invite.status ?? 'pending'];
              return (
                <TransferRow
                  key={invite.id}
                  row={{
                    id: invite.id,
                    counterparty: invite.to_email,
                    quotaGb: invite.quota_gb,
                    note: invite.note,
                    created: invite.created,
                  }}
                  action={
                    <ConfirmDeleteDialog
                      trigger={
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={
                            invite.status === 'pending'
                              ? 'Cancel invite'
                              : 'Dismiss invite'
                          }
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      }
                      title={
                        invite.status === 'pending'
                          ? 'Cancel this invite?'
                          : 'Dismiss this invite?'
                      }
                      description={
                        invite.status === 'pending'
                          ? `${invite.to_email} will no longer be able to claim ${formatStorage(invite.quota_gb)}. Nothing has left your account yet.`
                          : 'This removes the record. No storage moves either way.'
                      }
                      confirmText="remove"
                      confirmLabel="Remove"
                      onConfirm={() => onCancelInvite(invite.id)}
                    />
                  }
                >
                  <div className="mt-1 flex items-center gap-2">
                    <Badge variant={badge.variant} className="text-[10px]">
                      {badge.label}
                    </Badge>
                    {invite.failure_reason && (
                      <span className="text-xs text-destructive">
                        {invite.failure_reason}
                      </span>
                    )}
                  </div>
                </TransferRow>
              );
            })}
          </Section>
        )}
      </CardContent>

      <CardFooter className="border-t pt-4">
        <Button
          variant="outline"
          onClick={onTransfer}
          disabled={sendableGb <= 0}
        >
          <ArrowLeftRight className="mr-2 h-4 w-4" />
          Transfer or invite
        </Button>
      </CardFooter>
    </Card>
  );
}
