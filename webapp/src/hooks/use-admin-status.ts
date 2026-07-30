'use client';

import { useEffect, useState } from 'react';
import pb from '@/lib/pocketbase';
import { useAuth } from '@/hooks/use-auth';

interface AdminProbeState {
  isAdmin: boolean;
  isLoading: boolean;
}

const INITIAL_STATE: AdminProbeState = { isAdmin: false, isLoading: true };

/**
 * Returns whether the current user is an admin.
 * Uses the Admins collection's self-scoped read which 404s for non-admins.
 */
export function useAdminStatus(): AdminProbeState {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const [probe, setProbe] = useState<AdminProbeState>(INITIAL_STATE);

  useEffect(() => {
    if (authLoading || !isAuthenticated || !user) return;
    let cancelled = false;
    const check = async () => {
      try {
        await pb.collection('Admins').getFirstListItem(`user = "${user.id}"`);
        if (!cancelled) setProbe({ isAdmin: true, isLoading: false });
      } catch {
        if (!cancelled) setProbe({ isAdmin: false, isLoading: false });
      }
    };
    check();
    return () => {
      cancelled = true;
    };
  }, [authLoading, isAuthenticated, user]);

  if (authLoading) return INITIAL_STATE;
  if (!isAuthenticated || !user) return { isAdmin: false, isLoading: false };
  return probe;
}
