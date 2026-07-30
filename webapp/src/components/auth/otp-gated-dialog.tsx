'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/ui/input-otp';
import pb from '@/lib/pocketbase';
import { useAuth } from '@/hooks/use-auth';

interface OtpGatedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actionLabel: string;
  trigger?: ReactNode;
  children: ReactNode;
}

const RESEND_COOLDOWN = 30;

// Single Radix Dialog whose body switches from OTP step-up to `children` once
// the user verifies. Sharing one Dialog instance avoids the focus-restore race
// that self-dismissed the action modal when two sibling Dialogs were swapped
// on verification.
export function OtpGatedDialog({
  open,
  onOpenChange,
  actionLabel,
  trigger,
  children,
}: OtpGatedDialogProps) {
  const [verified, setVerified] = useState(false);

  function handleOpenChange(next: boolean) {
    if (!next) setVerified(false);
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent>
        {verified ? (
          children
        ) : (
          <OtpStepUp
            active={open}
            actionLabel={actionLabel}
            onVerified={() => setVerified(true)}
            onCancel={() => handleOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// Pure verification dialog. Calls onVerified once the OTP is accepted, then
// closes itself. Use this for fire-and-forget gating where the next step is an
// API call (e.g. toggling a permission), not opening another modal.
export function OtpVerificationDialog({
  open,
  onOpenChange,
  actionLabel,
  onVerified,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actionLabel: string;
  onVerified: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <OtpStepUp
          active={open}
          actionLabel={actionLabel}
          onVerified={() => {
            onOpenChange(false);
            onVerified();
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

interface OtpStepUpProps {
  active: boolean;
  actionLabel: string;
  onVerified: () => void;
  onCancel: () => void;
}

function OtpStepUp({
  active,
  actionLabel,
  onVerified,
  onCancel,
}: OtpStepUpProps) {
  const { user } = useAuth();
  const [otpId, setOtpId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const email = user?.email ?? '';

  async function resendCode() {
    if (!email) return;
    setSending(true);
    setSendError(null);
    setError(null);
    setCode('');
    try {
      const result = await pb.collection('Users').requestOTP(email);
      setOtpId(result.otpId);
      setCooldown(RESEND_COOLDOWN);
    } catch {
      setSendError(
        'Could not send verification code. Ensure SMTP is configured.'
      );
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (!active || !email) return;
    let cancelled = false;
    const send = async () => {
      setSending(true);
      setSendError(null);
      setError(null);
      setCode('');
      setOtpId(null);
      try {
        const result = await pb.collection('Users').requestOTP(email);
        if (cancelled) return;
        setOtpId(result.otpId);
        setCooldown(RESEND_COOLDOWN);
      } catch {
        if (cancelled) return;
        setSendError(
          'Could not send verification code. Ensure SMTP is configured.'
        );
      } finally {
        if (!cancelled) setSending(false);
      }
    };
    send();
    return () => {
      cancelled = true;
    };
  }, [active, email]);

  useEffect(() => {
    if (cooldown <= 0) return;
    cooldownRef.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          if (cooldownRef.current) clearInterval(cooldownRef.current);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, [cooldown]);

  async function verify(value: string) {
    if (!otpId || value.length !== 6) return;
    setVerifying(true);
    setError(null);
    try {
      await pb.collection('Users').authWithOTP(otpId, value);
      onVerified();
    } catch {
      setError('Invalid or expired code. Try again.');
      setCode('');
    } finally {
      setVerifying(false);
    }
  }

  const busy = sending || verifying;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Verify your identity</DialogTitle>
        <DialogDescription>
          Enter the 6-digit code sent to{' '}
          <span className="font-medium">{email}</span> to {actionLabel}.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        {sendError ? (
          <p className="text-sm text-destructive">{sendError}</p>
        ) : (
          <>
            <div className="flex justify-center">
              <InputOTP
                maxLength={6}
                value={code}
                onChange={(value) => {
                  setCode(value);
                  setError(null);
                  if (value.length === 6) verify(value);
                }}
                disabled={busy || !otpId}
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>

            {error && (
              <p className="text-center text-sm text-destructive">{error}</p>
            )}

            {sending ? (
              <p className="text-center text-sm text-muted-foreground">
                Sending code…
              </p>
            ) : (
              <p className="text-center text-sm text-muted-foreground">
                Didn&apos;t receive it?{' '}
                <button
                  type="button"
                  disabled={cooldown > 0 || busy}
                  onClick={resendCode}
                  className="underline disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
                </button>
              </p>
            )}
          </>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={() => verify(code)}
          disabled={busy || code.length !== 6 || !otpId}
        >
          {verifying ? 'Verifying…' : 'Verify'}
        </Button>
      </DialogFooter>
    </>
  );
}
