'use client';

import Link from 'next/link';
import { ArrowRight, PiggyBank } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatBytes, formatUsd } from '@/lib/format';
import {
  HEADLINE_RATE,
  buildCostComparison,
  garageRateFor,
  type PricingConfig,
  type ProviderCost,
} from '@/lib/pricing/rates';
import { cn } from '@/lib/utils';

/**
 * The one-line version of {@link StorageCostCard}, for the dashboard home.
 *
 * Two numbers and a way through: **what this quota costs here**, and **what it
 * would have cost elsewhere**. The full comparison — the providers, the bars,
 * the assumptions behind both figures — lives on `/dashboard/cluster`, which is
 * where the CTA goes. Splitting it that way is the point: the dashboard is a
 * working screen and a full pricing panel was taking a screenful of it to make
 * an argument the user only needs to read once.
 *
 * So this deliberately renders **no card chrome of its own beyond one band**:
 * a single row, fixed padding, no bars, no table. If it starts growing a second
 * row it has stopped being a summary.
 *
 * Presentation only — every figure comes from `lib/pricing/rates.ts`.
 */

export interface StorageCostSummaryProps {
  /**
   * The user's total storage quota in bytes — granted plus gifted, less gifted
   * away. `StorageSummary.netGrantedGb` converted with `gibToBytes`.
   */
  quotaBytes: number;
  /** The cluster's replication factor — a term in the hardware cost. */
  replicationFactor: number;
  /** This deployment's hardware cost basis. */
  pricing: PricingConfig;
  loading?: boolean;
  className?: string;
}

export function StorageCostSummary({
  quotaBytes,
  replicationFactor,
  pricing,
  loading,
  className,
}: StorageCostSummaryProps) {
  const rows = buildCostComparison(
    quotaBytes,
    garageRateFor(pricing, replicationFactor)
  );
  const here = rows.find((r) => r.isGarage);
  // A saving per provider, not just against the dearest. Quoting only the
  // headline invites "but B2 is cheap" — showing both answers it up front, and
  // the narrow figure is the more persuasive one for having been volunteered.
  const savings = rows.filter((r) => !r.isGarage);
  // On a phone there is room for one comparison, and it should be the cheapest
  // provider: it is the hardest test of the claim and the one a user weighing
  // alternatives would actually price against. Picked by total cost rather
  // than by taking the last row, so it stays right if the list is reordered.
  const cheapestKey = savings.reduce<ProviderCost | null>(
    (min, r) => (!min || r.annualUsd < min.annualUsd ? r : min),
    null
  )?.key;
  const hasQuota = quotaBytes > 0;

  return (
    <Card
      className={cn(
        'flex flex-row flex-wrap items-center justify-between gap-x-8 gap-y-4 px-6 py-5',
        className
      )}
    >
      {loading || !here || savings.length === 0 ? (
        <div
          className="h-10 w-64 animate-pulse rounded bg-muted"
          aria-label="Loading storage costs"
        />
      ) : hasQuota ? (
        <>
          <div className="flex items-center gap-4">
            <PiggyBank
              className="hidden h-6 w-6 shrink-0 text-muted-foreground sm:block"
              aria-hidden="true"
            />
            <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
              <div>
                <p className="text-2xl font-semibold leading-none tabular-nums">
                  {formatUsd(here.annualUsd)}
                  <span className="text-sm font-normal text-muted-foreground">
                    /yr
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  what your {formatBytes(quotaBytes)} costs here
                </p>
              </div>
              {/* Deliberately not coloured. A savings figure is text, and text
                  wears text tokens — the accent green that marks this cluster's
                  bar on the full panel sits at 2.74:1 on this surface, which is
                  below the bar even for large text. */}
              {savings.map((r) => (
                <div
                  key={r.key}
                  className={cn(r.key !== cheapestKey && 'hidden sm:block')}
                >
                  <p className="text-2xl font-semibold leading-none tabular-nums">
                    {formatUsd(r.savingsVsGarageAnnualUsd)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    saved a year vs {r.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
          <Button variant="outline" asChild>
            <Link href="/dashboard/cluster">
              See the numbers <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Storage here costs a fraction of {HEADLINE_RATE.label}. Ask an
            administrator for a quota to see what yours would be worth.
          </p>
          <Button variant="outline" asChild>
            <Link href="/dashboard/cluster">
              See the numbers <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </>
      )}
    </Card>
  );
}
