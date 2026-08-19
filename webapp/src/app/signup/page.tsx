'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { safeRedirect } from '@/lib/safe-redirect';
import { useAuth } from '@/hooks/use-auth';
import { useSetupStatus } from '@/lib/setup/use-setup-status';
import { SignupForm } from '@/components/auth/signup-form';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

function SignupContent() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  // `returnUrl` is what ProtectedRoute/AdminRoute emit and what login-form
  // reads after a successful sign-in; `redirect` is the older spelling still
  // used by /profile. Accept both here so an already-authenticated visitor
  // bounces to the page they actually asked for rather than to `/`.
  const redirectTo = safeRedirect(
    searchParams.get('returnUrl') ?? searchParams.get('redirect')
  );
  // Storage invites link here with the address the invite is held against.
  const invitedEmail = searchParams.get('email') || undefined;
  // `loaded` matters here: the seed is fail-safe (claimed, closed), and a page
  // must not tell a visitor sign-ups are disabled off a seed the server never
  // confirmed. `invite` mode keeps the form — invite emails deep-link here —
  // and the unclaimed bootstrap window keeps it too, since /setup sends the
  // future owner this way while sign-up is open regardless of mode.
  const { status: setupStatus, loaded: statusLoaded } = useSetupStatus();
  const signupsClosed =
    statusLoaded && setupStatus.claimed && setupStatus.signupMode === 'closed';

  useEffect(() => {
    // Redirect to home or intended destination if already authenticated
    if (!isLoading && isAuthenticated) {
      router.push(redirectTo);
    }
  }, [isLoading, isAuthenticated, router, redirectTo]);

  // Don't render anything if already authenticated (will redirect)
  if (isAuthenticated) {
    return null;
  }

  if (signupsClosed) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-md">
        <Card>
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl text-center">
              Sign-ups disabled
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground text-center">
              {/* Same sentence the PocketBase hook answers a direct attempt with. */}
              Sign-ups are disabled on this instance. Ask an administrator to
              create your account.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-md">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl text-center">Create account</CardTitle>
          <CardDescription className="text-center">
            Enter your information to create your account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignupForm redirectTo={redirectTo} defaultEmail={invitedEmail} />
        </CardContent>
      </Card>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <div className="container mx-auto px-4 py-8 max-w-md">
          <Card>
            <CardHeader className="space-y-1">
              <CardTitle className="text-2xl text-center">
                Create account
              </CardTitle>
              <CardDescription className="text-center">
                Enter your information to create your account
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="animate-pulse space-y-4">
                <div className="h-10 bg-muted rounded"></div>
                <div className="h-10 bg-muted rounded"></div>
                <div className="h-10 bg-muted rounded"></div>
              </div>
            </CardContent>
          </Card>
        </div>
      }
    >
      <SignupContent />
    </Suspense>
  );
}
