'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  ArrowLeftRight,
  CalendarClock,
  Coins,
  Database,
  Gauge,
  HardDrive,
  HeartPulse,
  History,
  Key,
  ServerCog,
  Users,
  Wrench,
} from 'lucide-react';
import { AdminRoute } from '@/components/auth/admin-route';
import { cn } from '@/lib/utils';

const links = [
  { href: '/admin', label: 'Overview', icon: Activity },
  { href: '/admin/cluster', label: 'Cluster', icon: Database },
  { href: '/admin/nodes', label: 'Nodes', icon: ServerCog },
  { href: '/admin/events', label: 'Events', icon: CalendarClock },
  { href: '/admin/repairs', label: 'Repairs', icon: Wrench },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/claims', label: 'Claims', icon: Coins },
  { href: '/admin/ledger', label: 'Ledger', icon: History },
  { href: '/admin/transfers', label: 'Transfers', icon: ArrowLeftRight },
  { href: '/admin/buckets', label: 'Buckets', icon: HardDrive },
  { href: '/admin/quota', label: 'Quota', icon: Gauge },
  { href: '/admin/keys', label: 'Keys', icon: Key },
  { href: '/admin/status', label: 'Status', icon: HeartPulse },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <AdminRoute>
      <div className="flex min-h-screen">
        <aside className="w-56 border-r bg-muted/40 p-4">
          <div className="mb-6">
            <h2 className="text-lg font-semibold">Admin console</h2>
          </div>
          <nav className="space-y-1">
            {links.map(({ href, label, icon: Icon }) => {
              const active =
                href === '/admin'
                  ? pathname === '/admin'
                  : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
                    active && 'bg-accent font-medium'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </Link>
              );
            })}
          </nav>
        </aside>
        <main className="flex-1">{children}</main>
      </div>
    </AdminRoute>
  );
}
