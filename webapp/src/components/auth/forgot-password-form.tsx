'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { getToastMessage } from '@garage-ware/shared';

const ForgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

type ForgotPasswordData = z.infer<typeof ForgotPasswordSchema>;

export function ForgotPasswordForm() {
  const { requestPasswordReset } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotPasswordData>({
    resolver: zodResolver(ForgotPasswordSchema),
  });

  const onSubmit = async (data: ForgotPasswordData) => {
    setIsLoading(true);
    try {
      await requestPasswordReset(data.email);
      // Always show the same confirmation regardless of whether the address is
      // registered, so we don't leak which emails have accounts.
      setSubmitted(true);
    } catch (error: unknown) {
      console.error('Password reset request failed:', error);
      const toastMessage = getToastMessage(error, 'Password reset');
      toast.error(toastMessage.title, {
        description: toastMessage.description,
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-gray-600">
          If an account exists for that address, we&apos;ve sent an email with a
          link to reset your password. The link expires in 3 hours.
        </p>
        <div className="text-center">
          <Link
            href="/login"
            className="text-sm font-medium text-blue-600 hover:text-blue-500"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            {...register('email')}
            placeholder="Enter your email"
            disabled={isLoading}
          />
          {errors.email && (
            <p className="text-sm text-red-600">{errors.email.message}</p>
          )}
        </div>

        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? 'Sending...' : 'Send reset link'}
        </Button>
      </form>

      <div className="text-center">
        <Link
          href="/login"
          className="text-sm font-medium text-blue-600 hover:text-blue-500"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
