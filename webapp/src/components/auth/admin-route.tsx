'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { useAdminStatus } from '@/hooks/use-admin-status';

interface AdminRouteProps {
  children: React.ReactNode;
}

export function AdminRoute({ children }: AdminRouteProps) {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { isAdmin, isLoading: adminLoading } = useAdminStatus();
  const router = useRouter();

  useEffect(() => {
    if (authLoading || adminLoading) return;
    if (!isAuthenticated) {
      router.push('/login?returnUrl=/admin');
      return;
    }
    if (!isAdmin) {
      router.push('/dashboard');
    }
  }, [authLoading, adminLoading, isAuthenticated, isAdmin, router]);

  if (authLoading || adminLoading || !isAuthenticated || !isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return <>{children}</>;
}

export default AdminRoute;
