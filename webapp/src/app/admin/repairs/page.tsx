'use client';

import Link from 'next/link';
import { ArrowRight, ScanSearch, Blocks, Scale } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useRepairData } from '@/hooks/use-repair-data';

/**
 * A real index, not a redirect to /scrub.
 *
 * These are expensive, multi-day, unstoppable operations, and a redirect would
 * drop an admin who arrived cold straight in front of a Start button with no
 * idea what it costs. The copy below is the only warning they get; don't cut it
 * for brevity.
 */
const OPERATIONS = [
  {
    href: '/admin/repairs/scrub',
    icon: ScanSearch,
    title: 'Scrub',
    body: 'Re-reads every block a node stores and verifies it against its checksum, finding silent corruption nothing else looks for. Takes days to weeks, throttles itself, and can be paused. Garage runs one automatically about once a month.',
  },
  {
    href: '/admin/repairs/blocks',
    icon: Blocks,
    title: 'Block repair',
    body: 'Walks every block reference a node should hold and re-fetches what is missing from its peers. This is what you run after replacing a drive. Takes hours to days and cannot be paused.',
  },
  {
    href: '/admin/repairs/rebalance',
    icon: Scale,
    title: 'Rebalance',
    body: 'Moves stored blocks to where the current layout says they belong. Run it after adding a node or changing a capacity, once the layout is applied. Takes hours to days and cannot be paused.',
  },
];

export default function RepairsOverviewPage() {
  const { rows, loading, workersUnavailable } = useRepairData();

  const busyNodes = rows.filter((r) => (r.workers?.busyCount ?? 0) > 0).length;
  const erroredNodes = rows.filter(
    (r) => (r.workers?.erroredCount ?? 0) > 0
  ).length;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Cluster worker state</CardTitle>
          <CardDescription>
            What is running right now — worth checking before starting anything
            that will run for days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : workersUnavailable ? (
            <p className="text-muted-foreground text-sm">
              Could not read worker state from the cluster.
            </p>
          ) : (
            <div className="flex gap-8">
              <div>
                <div className="text-2xl font-semibold">{busyNodes}</div>
                <div className="text-muted-foreground text-sm">
                  {busyNodes === 1 ? 'node' : 'nodes'} with a busy worker
                </div>
              </div>
              <div>
                <div className="text-2xl font-semibold">{erroredNodes}</div>
                <div className="text-muted-foreground text-sm">
                  {erroredNodes === 1 ? 'node' : 'nodes'} with a worker in error
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {OPERATIONS.map(({ href, icon: Icon, title, body }) => (
          <Card key={href} className="flex flex-col">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Icon className="h-4 w-4" />
                {title}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col justify-between gap-4">
              <p className="text-muted-foreground text-sm">{body}</p>
              <Link href={href}>
                <Button variant="outline" size="sm" className="gap-1.5">
                  Open <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
