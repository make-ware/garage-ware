'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api-client';
import { toast } from 'sonner';

const InviteSchema = z.object({
  email: z.string().email('Invalid email address'),
  name: z.string().max(255, 'Name must be less than 255 characters').optional(),
});

type InviteData = z.infer<typeof InviteSchema>;

interface InviteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful invite so the caller can refresh its list. */
  onInvited?: () => void | Promise<void>;
}

export function InviteUserDialog({
  open,
  onOpenChange,
  onInvited,
}: InviteUserDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<InviteData>({
    resolver: zodResolver(InviteSchema),
  });

  useEffect(() => {
    if (!open) {
      reset();
      setSubmitting(false);
    }
  }, [open, reset]);

  const onSubmit = async (data: InviteData) => {
    setSubmitting(true);
    try {
      await api('/next-api/garage/users', {
        method: 'POST',
        body: { email: data.email, name: data.name || undefined },
      });
      toast.success(`Invitation sent to ${data.email}`);
      await onInvited?.();
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invite failed';
      // Surface a duplicate-email conflict on the field it belongs to.
      if (/already exists/i.test(message)) {
        setError('email', { type: 'manual', message });
      } else {
        setError('root', { type: 'manual', message });
      }
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite user</DialogTitle>
          <DialogDescription>
            Create an account and email the person a link to set their own
            password. They&apos;ll appear in the list once invited.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="person@example.com"
              autoComplete="off"
              {...register('email')}
              disabled={submitting}
            />
            {errors.email && (
              <p className="text-sm text-red-600">{errors.email.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="invite-name">Name (optional)</Label>
            <Input
              id="invite-name"
              type="text"
              placeholder="Jane Doe"
              {...register('name')}
              disabled={submitting}
            />
            {errors.name && (
              <p className="text-sm text-red-600">{errors.name.message}</p>
            )}
          </div>

          {errors.root && (
            <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">
              {errors.root.message}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send invitation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
