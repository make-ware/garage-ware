'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, CheckCircle2, Circle, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  StatusChecks,
  type Diagnostics,
} from '@/components/setup/status-checks';

interface SetupStatus {
  claimed: boolean;
  pocketbaseOk: boolean;
  signupMode: string;
  needsGarageConfig: boolean;
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        {done ? (
          <CheckCircle2 className="h-6 w-6 text-emerald-500" />
        ) : (
          <Circle className="h-6 w-6 text-muted-foreground" />
        )}
        <div className="mt-1 w-px flex-1 bg-border" />
      </div>
      <div className="flex-1 pb-8">
        <h3 className="mb-2 font-semibold">
          <span className="text-muted-foreground">{n}. </span>
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}

function SetupContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading, user } = useAuth();

  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [token, setToken] = useState(searchParams.get('token') ?? '');
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);

  const refreshStatus = useCallback(async () => {
    const result = await api<SetupStatus>('/next-api/setup/status');
    setStatus(result);
    return result;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const result = await api<SetupStatus>('/next-api/setup/status');
        if (!cancelled) {
          setStatus(result);
          setStatusError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setStatusError(
            err instanceof Error ? err.message : 'Could not reach this instance'
          );
        }
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  // Diagnostics need a session. While unclaimed any signed-in user may read
  // them, which is the whole point — the owner has to be able to see why Garage
  // is unreachable before they can become an admin.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    const run = async () => {
      try {
        const result = await api<Diagnostics>('/next-api/status');
        if (!cancelled) setDiagnostics(result);
      } catch {
        // Non-fatal: once an admin exists this 403s for everyone else, which is
        // correct, and the setup page should still render its other steps.
        if (!cancelled) setDiagnostics(null);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, status?.claimed]);

  const claim = async () => {
    setClaiming(true);
    setClaimError(null);
    try {
      await api('/next-api/setup/claim', {
        method: 'POST',
        body: { token: token.trim() },
      });
      toast.success('You are now the administrator of this instance');
      await refreshStatus();
      router.push('/admin/status');
    } catch (err) {
      setClaimError(
        err instanceof Error ? err.message : 'Could not claim this instance'
      );
    } finally {
      setClaiming(false);
    }
  };

  if (statusError) {
    return (
      <Card className="border-destructive">
        <CardHeader>
          <CardTitle>Cannot reach this instance</CardTitle>
          <CardDescription>{statusError}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card>
        <CardContent className="pt-6 text-muted-foreground">
          Checking this instance…
        </CardContent>
      </Card>
    );
  }

  // The server could not reach PocketBase, so it could not tell whether an
  // administrator exists — and it reports `claimed: true` in that case rather
  // than inviting a takeover. Say what is actually wrong instead of rendering
  // either the wizard or a misleading "already set up".
  if (!status.pocketbaseOk) {
    return (
      <Card className="border-destructive">
        <CardHeader>
          <CardTitle>This deployment is not fully configured</CardTitle>
          <CardDescription>
            The app cannot authenticate to its own database, so it cannot tell
            whether this instance has an administrator yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Check that{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              POCKETBASE_ADMIN_EMAIL
            </code>{' '}
            and{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              POCKETBASE_ADMIN_PASSWORD
            </code>{' '}
            match a real PocketBase superuser, then restart the container.
          </p>
          <p>
            In Docker these are generated on first boot and stored at{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              /data/pb_superuser.env
            </code>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  if (status.claimed) {
    return (
      <Card>
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-500" />
            <CardTitle>This instance is already set up</CardTitle>
          </div>
          <CardDescription>
            An administrator has claimed it. If you need access, ask them to
            invite you from the admin console.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Link href="/login">
            <Button>
              Sign in <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Set up this instance</h1>
        <p className="mt-2 text-muted-foreground">
          Nobody administers this deployment yet. These steps make you its
          administrator.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <Step n={1} title="Create your account" done={isAuthenticated}>
            {authLoading ? (
              <p className="text-sm text-muted-foreground">Checking…</p>
            ) : isAuthenticated ? (
              <p className="text-sm text-muted-foreground">
                Signed in as {user?.email}.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Sign up with the address you want to administer this instance
                  with. While no administrator exists, sign-up is open — which
                  is why claiming it promptly matters.
                </p>
                <div className="flex gap-2">
                  <Link href="/signup?returnUrl=/setup">
                    <Button size="sm">Create account</Button>
                  </Link>
                  <Link href="/login?returnUrl=/setup">
                    <Button size="sm" variant="outline">
                      I already have one
                    </Button>
                  </Link>
                </div>
              </div>
            )}
          </Step>

          <Step
            n={2}
            title="Claim the administrator role"
            done={status.claimed}
          >
            {!isAuthenticated ? (
              <p className="text-sm text-muted-foreground">
                Sign in first, so the role can be granted to your account.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Your deployment printed a one-time claim token when it
                  started. Find it with{' '}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    docker compose logs garage-ware | grep &apos;\[setup\]&apos;
                  </code>
                  , or read{' '}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    /data/setup/claim-token
                  </code>{' '}
                  inside the container.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="claim-token">Claim token</Label>
                  <div className="flex gap-2">
                    <Input
                      id="claim-token"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="paste the token from your container logs"
                      className="font-mono"
                      autoComplete="off"
                    />
                    <Button
                      onClick={claim}
                      disabled={claiming || token.trim().length === 0}
                    >
                      {claiming ? 'Claiming…' : 'Claim'}
                    </Button>
                  </div>
                </div>
                {claimError && (
                  <p className="text-sm text-destructive">{claimError}</p>
                )}
              </div>
            )}
          </Step>

          <Step
            n={3}
            title="Connect your Garage cluster"
            done={isAuthenticated && !status.needsGarageConfig}
          >
            {!isAuthenticated ? (
              <p className="text-sm text-muted-foreground">
                Sign in to see what this deployment can and cannot reach.
              </p>
            ) : diagnostics ? (
              <StatusChecks checks={diagnostics.checks} />
            ) : (
              <p className="text-sm text-muted-foreground">Running checks…</p>
            )}
          </Step>

          <div className="flex gap-4">
            <div className="flex flex-col items-center">
              <Circle className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="flex-1">
              <h3 className="mb-2 font-semibold">
                <span className="text-muted-foreground">4. </span>
                Then what
              </h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>
                  Grant yourself storage on{' '}
                  <span className="font-medium">Admin → Claims</span> — until a
                  user holds a claim they cannot create any bucket.
                </li>
                <li>
                  Configure SMTP in the PocketBase settings, or invites and
                  password resets will never arrive.
                </li>
                <li>
                  Invite people from{' '}
                  <span className="font-medium">Admin → Users</span>, or send
                  them storage from your dashboard — an address with no account
                  gets an invite it can sign up against.
                </li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function SetupPage() {
  return (
    <div className="container mx-auto max-w-3xl px-4 py-8">
      <Suspense
        fallback={
          <Card>
            <CardContent className="pt-6 text-muted-foreground">
              Checking this instance…
            </CardContent>
          </Card>
        }
      >
        <SetupContent />
      </Suspense>
    </div>
  );
}
