'use client';

import { Suspense } from 'react';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

function ResetPasswordShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="container mx-auto px-4 py-8 max-w-md">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl text-center">
            Set a new password
          </CardTitle>
          <CardDescription className="text-center">
            Choose a new password for your account.
          </CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <ResetPasswordShell>
          <div className="animate-pulse space-y-4">
            <div className="h-10 bg-muted rounded"></div>
            <div className="h-10 bg-muted rounded"></div>
            <div className="h-10 bg-muted rounded"></div>
          </div>
        </ResetPasswordShell>
      }
    >
      <ResetPasswordShell>
        <ResetPasswordForm />
      </ResetPasswordShell>
    </Suspense>
  );
}
