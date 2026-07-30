'use client';

import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function ForgotPasswordPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-md">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl text-center">
            Reset your password
          </CardTitle>
          <CardDescription className="text-center">
            Enter your account email and we&apos;ll send you a reset link.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ForgotPasswordForm />
        </CardContent>
      </Card>
    </div>
  );
}
