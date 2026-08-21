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
  /**
   * The guide is not an operation, so it is set apart with `ml-auto` rather
   * than queued after Rebalance as if it were a fifth thing to run. It earns a
   * route rather than a section on the overview for this nav's own stated
   * reason: an operator can paste a link to it into an incident channel, and it
   * is the most paste-worthy page in the section.
   *
   * `pathname === href` is exact, so Overview correctly goes dark here with no
   * change to the logic below. Five ghost buttons on a `border-b` is the limit
   * for this nav; a sixth needs a redesign, not another entry.
   */
  { href: '/admin/repairs/guide', label: 'Guide', apart: true },
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
        {tabs.map(({ href, label, apart }) => (
          <Link
            key={href}
            href={href}
            className={apart ? 'ml-auto' : undefined}
          >
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
