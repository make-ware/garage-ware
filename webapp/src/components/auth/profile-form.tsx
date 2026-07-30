'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import {
  parseAuthError,
  getFieldError,
  getToastMessage,
} from '@garage-ware/shared';

// Schema for profile updates. Email is intentionally excluded — the account
// email is fixed and cannot be changed from the app (see the read-only field
// below); PocketBase also blocks direct email changes for regular users.
const ProfileUpdateSchema = z.object({
  name: z.string().max(255, 'Name must be less than 255 characters').optional(),
});

// Schema for password change
const PasswordChangeSchema = z
  .object({
    oldPassword: z.string().min(1, 'Current password is required'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    passwordConfirm: z.string(),
  })
  .refine((data) => data.password === data.passwordConfirm, {
    message: "Passwords don't match",
    path: ['passwordConfirm'],
  });

// Schema for notification preferences
const NotificationSchema = z.object({
  notification_threshold_pct: z
    .number()
    .int('Must be a whole number')
    .min(10, 'Minimum is 10%')
    .max(99, 'Maximum is 99%'),
});

type ProfileUpdateData = z.infer<typeof ProfileUpdateSchema>;
type PasswordChangeData = z.infer<typeof PasswordChangeSchema>;

export function ProfileForm() {
  const { user, updateProfile, changePassword } = useAuth();
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isUpdatingNotif, setIsUpdatingNotif] = useState(false);

  // Profile update form
  const profileForm = useForm<ProfileUpdateData>({
    resolver: zodResolver(ProfileUpdateSchema),
    defaultValues: {
      name: user?.name || '',
    },
  });

  // Password change form
  const passwordForm = useForm<PasswordChangeData>({
    resolver: zodResolver(PasswordChangeSchema),
  });

  // Notification preferences form
  const notifForm = useForm<z.infer<typeof NotificationSchema>>({
    resolver: zodResolver(NotificationSchema),
    defaultValues: {
      notification_threshold_pct: user?.notification_threshold_pct ?? 90,
    },
  });

  const onProfileSubmit = async (data: ProfileUpdateData) => {
    setIsUpdatingProfile(true);
    try {
      await updateProfile(data);
      toast.success('Profile updated successfully!');
    } catch (error: unknown) {
      console.error('Profile update failed:', error);

      const parsedError = parseAuthError(error);

      // Set field-specific errors
      const nameError = getFieldError(error, 'name');

      if (nameError) {
        profileForm.setError('name', { type: 'manual', message: nameError });
      } else {
        // Set general error if no field-specific errors
        profileForm.setError('root', {
          type: 'manual',
          message: parsedError.message,
        });
      }

      // Show toast with appropriate message
      const toastMessage = getToastMessage(error, 'Profile update');
      toast.error(toastMessage.title, {
        description: toastMessage.description,
      });
    } finally {
      setIsUpdatingProfile(false);
    }
  };

  const onPasswordSubmit = async (data: PasswordChangeData) => {
    setIsChangingPassword(true);
    try {
      await changePassword(
        data.oldPassword,
        data.password,
        data.passwordConfirm
      );
      toast.success('Password changed successfully!');
      passwordForm.reset();
    } catch (error: unknown) {
      console.error('Password change failed:', error);

      const parsedError = parseAuthError(error);

      // Set field-specific errors
      const oldPasswordError = getFieldError(error, 'oldPassword');
      const passwordError = getFieldError(error, 'password');

      if (
        oldPasswordError ||
        parsedError.message.includes('old password') ||
        parsedError.message.includes('current password')
      ) {
        passwordForm.setError('oldPassword', {
          type: 'manual',
          message: 'Current password is incorrect.',
        });
      } else if (passwordError) {
        passwordForm.setError('password', {
          type: 'manual',
          message: passwordError,
        });
      } else {
        passwordForm.setError('root', {
          type: 'manual',
          message: parsedError.message,
        });
      }

      // Show toast with appropriate message
      const toastMessage = getToastMessage(error, 'Password change');
      toast.error(toastMessage.title, {
        description: toastMessage.description,
      });
    } finally {
      setIsChangingPassword(false);
    }
  };

  const onNotifSubmit = async (data: z.infer<typeof NotificationSchema>) => {
    setIsUpdatingNotif(true);
    try {
      await updateProfile(data);
      toast.success('Notification preferences saved!');
    } catch (error: unknown) {
      const toastMessage = getToastMessage(error, 'Notification update');
      toast.error(toastMessage.title, {
        description: toastMessage.description,
      });
    } finally {
      setIsUpdatingNotif(false);
    }
  };

  if (!user) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-center text-gray-600">
            Please log in to view your profile.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Profile Information Card */}
      <Card>
        <CardHeader>
          <CardTitle>Profile Information</CardTitle>
          <CardDescription>Update your personal information.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={profileForm.handleSubmit(onProfileSubmit)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                type="text"
                {...profileForm.register('name')}
                placeholder="Enter your name"
                disabled={isUpdatingProfile}
              />
              {profileForm.formState.errors.name && (
                <p className="text-sm text-red-600">
                  {profileForm.formState.errors.name.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={user.email}
                readOnly
                disabled
                aria-describedby="email-help"
              />
              <p id="email-help" className="text-sm text-muted-foreground">
                Your account email can&apos;t be changed. Contact an
                administrator if it needs updating.
              </p>
            </div>

            {profileForm.formState.errors.root && (
              <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">
                {profileForm.formState.errors.root.message}
              </div>
            )}

            <Button type="submit" disabled={isUpdatingProfile}>
              {isUpdatingProfile ? 'Updating...' : 'Update Profile'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Separator />

      {/* Password Change Card */}
      <Card>
        <CardHeader>
          <CardTitle>Change Password</CardTitle>
          <CardDescription>
            Update your password to keep your account secure.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={passwordForm.handleSubmit(onPasswordSubmit)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="oldPassword">Current Password</Label>
              <Input
                id="oldPassword"
                type="password"
                {...passwordForm.register('oldPassword')}
                placeholder="Enter your current password"
                disabled={isChangingPassword}
              />
              {passwordForm.formState.errors.oldPassword && (
                <p className="text-sm text-red-600">
                  {passwordForm.formState.errors.oldPassword.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">New Password</Label>
              <Input
                id="password"
                type="password"
                {...passwordForm.register('password')}
                placeholder="Enter your new password"
                disabled={isChangingPassword}
              />
              {passwordForm.formState.errors.password && (
                <p className="text-sm text-red-600">
                  {passwordForm.formState.errors.password.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="passwordConfirm">Confirm New Password</Label>
              <Input
                id="passwordConfirm"
                type="password"
                {...passwordForm.register('passwordConfirm')}
                placeholder="Confirm your new password"
                disabled={isChangingPassword}
              />
              {passwordForm.formState.errors.passwordConfirm && (
                <p className="text-sm text-red-600">
                  {passwordForm.formState.errors.passwordConfirm.message}
                </p>
              )}
            </div>

            {passwordForm.formState.errors.root && (
              <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">
                {passwordForm.formState.errors.root.message}
              </div>
            )}

            <Button type="submit" disabled={isChangingPassword}>
              {isChangingPassword ? 'Changing Password...' : 'Change Password'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Separator />

      {/* Notification Preferences Card */}
      <Card>
        <CardHeader>
          <CardTitle>Notification Preferences</CardTitle>
          <CardDescription>
            Receive a daily email when any bucket exceeds your chosen fill
            threshold (10–99%).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={notifForm.handleSubmit(onNotifSubmit)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="notification_threshold_pct">
                Alert threshold (% full)
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="notification_threshold_pct"
                  type="number"
                  min={10}
                  max={99}
                  className="w-24"
                  {...notifForm.register('notification_threshold_pct', {
                    valueAsNumber: true,
                  })}
                  disabled={isUpdatingNotif}
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
              {notifForm.formState.errors.notification_threshold_pct && (
                <p className="text-sm text-red-600">
                  {
                    notifForm.formState.errors.notification_threshold_pct
                      .message
                  }
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                Default is 90%. You will receive at most one email per day.
              </p>
            </div>

            <Button type="submit" disabled={isUpdatingNotif}>
              {isUpdatingNotif ? 'Saving...' : 'Save Preferences'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
