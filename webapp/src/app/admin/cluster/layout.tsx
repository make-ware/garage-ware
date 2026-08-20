'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';

/**
 * The Cluster section: what the cluster is now, and what it would be.
 *
 * Real sub-routes rather than a `<Tabs>`, for the reasons
 * `admin/repairs/layout.tsx` gives — a planner an operator can paste into an
 * incident channel is most of its value.
 *
 * No `<AdminRoute>` here: app/admin/layout.tsx already wraps this tree, and its
 * active detection is `pathname.startsWith('/admin/cluster')`, so the sidebar
 * entry stays lit on every sub-route with no change to it.
 *
 * The file is `layout.tsx` and the *planner* lives at `/admin/cluster/planner`
 * rather than `/admin/cluster/layout` on purpose: a `layout/` directory beside
 * Next's reserved `layout.tsx` is legal, but every `grep cluster/layout` would
 * then return the API route, the Next convention and the page at once.
 */
const tabs = [
  { href: '/admin/cluster', label: 'Overview' },
  { href: '/admin/cluster/planner', label: 'Layout planner' },
  // Staging lives at `/staging` for the same reason the planner is not at
  // `/layout`: this file is `layout.tsx`, and a sibling `layout/` directory
  // would make every `grep cluster/layout` ambiguous. "Layout staging" is what
  // it is called everywhere it is named.
  { href: '/admin/cluster/staging', label: 'Layout staging' },
];

export default function ClusterLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Cluster</h1>
      </div>
      <nav className="mb-6 flex gap-1 border-b pb-3">
        {tabs.map(({ href, label }) => (
          <Link key={href} href={href}>
            <Button
              variant={pathname === href ? 'secondary' : 'ghost'}
              size="sm"
            >
              {label}
            </Button>
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
