'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';

/**
 * The Repairs section: one route per repair operation.
 *
 * **Real sub-routes rather than a `<Tabs>`.** `components/ui/tabs.tsx` exists
 * but is imported nowhere in this app, and tabs driven by local state would put
 * all three operations behind one URL — losing deep links, back-button
 * behaviour, per-page loading, and a link an operator can paste into an
 * incident channel. Wiring Tabs back to the router is also strictly more code
 * than three `<Link>`s.
 *
 * No `<AdminRoute>` here: app/admin/layout.tsx already wraps this whole tree,
 * and a second wrapper would run the admin check twice. That layout's active
 * detection is `pathname.startsWith(href)` for non-`/admin` entries, so
 * "Repairs" stays lit on every sub-route with no change to it — this is a
 * second level of nav, not a competitor to the first.
 */
const tabs = [
  { href: '/admin/repairs', label: 'Overview' },
  { href: '/admin/repairs/scrub', label: 'Scrub' },
  { href: '/admin/repairs/blocks', label: 'Blocks' },
  { href: '/admin/repairs/rebalance', label: 'Rebalance' },
];

export default function RepairsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Repairs</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Garage maintenance operations, run per node. Every one of these runs
          in the background for hours to weeks, cannot be paused except where
          noted, and is recorded on the cluster timeline.
        </p>
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
