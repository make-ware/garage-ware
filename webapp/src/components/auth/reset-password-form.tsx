'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import {
  parseAuthError,
  getFieldError,
  getToastMessage,
} from '@garage-ware/shared';

const ResetPasswordSchema = z
  .object({
    password: z.string().min(8, 'Password must be at least 8 characters'),
    passwordConfirm: z.string(),
  })
  .refine((data) => data.password === data.passwordConfirm, {
    message: "Passwords don't match",
    path: ['passwordConfirm'],
  });

type ResetPasswordData = z.infer<typeof ResetPasswordSchema>;

export function ResetPasswordForm() {
  const { confirmPasswordReset } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    setError,
  } = useForm<ResetPasswordData>({
    resolver: zodResolver(ResetPasswordSchema),
  });

  const onSubmit = async (data: ResetPasswordData) => {
    setIsLoading(true);
    try {
      await confirmPasswordReset(token, data.password, data.passwordConfirm);
      toast.success('Password reset successfully. Please sign in.');
      router.push('/login');
    } catch (error: unknown) {
      console.error('Password reset failed:', error);

      const parsedError = parseAuthError(error);
      const passwordError = getFieldError(error, 'password');

      if (passwordError) {
        setError('password', { type: 'manual', message: passwordError });
      } else {
        setError('root', { type: 'manual', message: parsedError.message });
      }

      const toastMessage = getToastMessage(error, 'Password reset');
      toast.error(toastMessage.title, {
        description: toastMessage.description,
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="space-y-6">
        <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">
          This password reset link is missing its token or is invalid. Please
          request a new one.
        </div>
        <div className="text-center">
          <Link
            href="/forgot-password"
            className="text-sm font-medium text-blue-600 hover:text-blue-500"
          >
            Request a new reset link
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">New Password</Label>
          <Input
            id="password"
            type="password"
            {...register('password')}
            placeholder="Enter your new password"
            disabled={isLoading}
          />
          {errors.password && (
            <p className="text-sm text-red-600">{errors.password.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="passwordConfirm">Confirm New Password</Label>
          <Input
            id="passwordConfirm"
            type="password"
            {...register('passwordConfirm')}
            placeholder="Confirm your new password"
            disabled={isLoading}
          />
          {errors.passwordConfirm && (
            <p className="text-sm text-red-600">
              {errors.passwordConfirm.message}
            </p>
          )}
        </div>

        {errors.root && (
          <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">
            {errors.root.message}
          </div>
        )}

        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? 'Resetting...' : 'Reset password'}
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
