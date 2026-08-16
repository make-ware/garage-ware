'use client';

import { PiggyBank } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatBytes, formatMultiple, formatUsd } from '@/lib/format';
import {
  RATES_AS_OF,
  buildCostComparison,
  cheapestAlternative,
  garageRateFor,
  type PricingConfig,
  type ProviderCost,
  type Rate,
} from '@/lib/pricing/rates';
import { cn } from '@/lib/utils';

/**
 * What this storage would cost elsewhere — for the reader, and for the cluster.
 *
 * Two sections over the same three rates: **your storage**, the quota held for
 * this user, and **this cluster**, everything the layout can back. They are
 * separate blocks rather than one blended figure because they answer different
 * questions — what am I getting, and what is this thing worth — and averaging
 * them would answer neither.
 *
 * Presentation only. Every figure comes from `lib/pricing/rates.ts`; nothing
 * here re-derives a rate, an amortization or a saving — the same rule the
 * storage cards follow for ledger arithmetic, and for the same reason.
 *
 * The one-line version for the dashboard home is `storage-cost-summary.tsx`.
 * This panel carries no call to action: it lives on the page one would link to.
 *
 * ## Why a table rather than bars
 *
 * The figures span nearly two orders of magnitude, which is exactly the range
 * bars are worst at: this cluster's row was ~27x shorter than S3's and had to
 * be floored to a visible minimum to render at all — at which point the bar is
 * no longer showing the ratio it exists to show. The numbers do that job
 * honestly, and a table gives room for the periods side by side. The last
 * column is the one that lands: over the hardware's life, this cluster's total
 * *is* the disk purchase price.
 */

export interface StorageCostCardProps {
  /**
   * The user's total storage quota, in bytes — net granted: what an admin has
   * granted them, **plus storage gifted by other users**, less anything they
   * have gifted away. `StorageSummary.netGrantedGb` is exactly this sum, so a
   * caller passes it straight through.
   *
   * A quota is capacity held for this user whether or not they have written to
   * it, which is the like-for-like quantity against a provider you would have
   * to provision the same capacity from. ("Claim" is the ledger's term for the
   * admin-granted half of it and stays in the accounting code; user-facing copy
   * says quota.)
   */
  quotaBytes: number;
  /** Cluster-wide usable-after-replication capacity, in bytes. */
  clusterUsableBytes: number;
  /** The cluster's replication factor — a term in the hardware cost. */
  replicationFactor: number;
  /** This deployment's hardware cost basis. */
  pricing: PricingConfig;
  loading?: boolean;
  className?: string;
}

/** One priced footprint: a headline, then a row per provider. */
function CostSection({
  heading,
  caption,
  bytes,
  garageRate,
  horizonYears,
}: {
  heading: string;
  caption: string;
  bytes: number;
  garageRate: Rate;
  horizonYears: number;
}) {
  const rows = buildCostComparison(bytes, garageRate, horizonYears);
  // The **cheapest** commercial row, not the dearest: the headline should be
  // the hardest test of the claim, and a reader who opens the table below then
  // finds a larger saving they were not sold. The dearer provider is still
  // there, in the evidence, where it is a check rather than a pitch.
  const headline = cheapestAlternative(rows);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-medium">{heading}</h3>
        <p className="text-xs text-muted-foreground">{caption}</p>
      </div>

      {headline && (
        <div className="mt-3 mb-1 flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <div>
            <p className="text-3xl font-semibold leading-none tabular-nums">
              {formatUsd(headline.savingsVsGarageAnnualUsd)}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              saved a year against {headline.label}
            </p>
          </div>
          <div>
            <p className="text-lg font-semibold leading-none tabular-nums">
              {formatMultiple(headline.multipleOfGarage)}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              the cost, elsewhere
            </p>
          </div>
        </div>
      )}

      {/* Collapsed by default. The headline above answers the question; the
          table is the evidence, and evidence should be available rather than
          unavoidable — especially on a phone, where an open five-column table
          would be most of the screen. */}
      <Accordion type="single" collapsible>
        <AccordionItem value="details" className="border-b-0">
          <AccordionTrigger className="py-3">View details</AccordionTrigger>
          <AccordionContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    {/* Two columns fold away on small screens rather than
                        forcing a horizontal scroll. Annual and the lifespan
                        total survive: they are the two the copy quotes, and
                        the rate is recoverable from either. */}
                    <TableHead className="hidden text-right md:table-cell">
                      Rate /TB/mo
                    </TableHead>
                    <TableHead className="hidden text-right sm:table-cell">
                      Monthly
                    </TableHead>
                    <TableHead className="text-right">Annual</TableHead>
                    <TableHead className="text-right">
                      {horizonYears} year{horizonYears === 1 ? '' : 's'}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <CostRow key={r.key} row={r} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  );
}

function CostRow({ row }: { row: ProviderCost }) {
  return (
    <TableRow className={cn(row.isGarage && 'font-medium')}>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help underline decoration-dotted underline-offset-4">
              {row.label}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{row.note}</TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">
        {formatUsd(row.usdPerTbMonth)}
      </TableCell>
      <TableCell className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">
        {formatUsd(row.monthlyUsd)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatUsd(row.annualUsd)}
      </TableCell>
      <TableCell
        className={cn(
          'text-right tabular-nums',
          row.isGarage ? 'font-semibold' : 'text-muted-foreground'
        )}
      >
        {formatUsd(row.horizonUsd)}
      </TableCell>
    </TableRow>
  );
}

export function StorageCostCard({
  quotaBytes,
  clusterUsableBytes,
  replicationFactor,
  pricing,
  loading,
  className,
}: StorageCostCardProps) {
  const garageRate = garageRateFor(pricing, replicationFactor);
  const hasQuota = quotaBytes > 0;
  const hasCluster = clusterUsableBytes > 0;
  const rf = Math.max(replicationFactor, 1);

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PiggyBank className="h-5 w-5" />
          What this storage would cost elsewhere
        </CardTitle>
        <CardDescription>
          Your quota and the whole cluster, at published cloud prices.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex-1">
        {loading ? (
          <div
            className="h-64 animate-pulse rounded bg-muted"
            aria-label="Loading cost comparison"
          />
        ) : (
          <div className="space-y-8">
            {/* Side by side once there is room for two five-column tables, and
                stacked below that. The split is at `xl`, not `lg`: this page's
                container caps at max-w-6xl, so an `lg` viewport leaves each
                column ~456px — enough to render the table only by scrolling it,
                which defeats putting them side by side in the first place. At
                `xl` each column gets ~520px and both tables fit whole.

                Only gridded when both halves exist; a lone section at half
                width with dead space beside it reads as a rendering fault. */}
            <div
              className={cn(
                'grid gap-8',
                hasQuota && hasCluster && 'xl:grid-cols-2 xl:items-start'
              )}
            >
              {hasQuota ? (
                <CostSection
                  heading="Your storage"
                  caption={`${formatBytes(quotaBytes)} quota`}
                  bytes={quotaBytes}
                  garageRate={garageRate}
                  horizonYears={pricing.hardwareLifespanYears}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  You have no storage quota yet. Ask an administrator for one to
                  see what yours would be worth.
                </p>
              )}

              {hasCluster && (
                <CostSection
                  heading="This cluster"
                  caption={`${formatBytes(clusterUsableBytes)} usable, after ${rf}× replication`}
                  bytes={clusterUsableBytes}
                  garageRate={garageRate}
                  horizonYears={pricing.hardwareLifespanYears}
                />
              )}
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Storage plus egress, assuming the data is read back once a year.
              This cluster is hardware at {formatUsd(pricing.garageUsdPerTb)}
              /raw TB × {rf} replica{rf === 1 ? '' : 's'} over{' '}
              {pricing.hardwareLifespanYears} year
              {pricing.hardwareLifespanYears === 1 ? '' : 's'}, excluding power,
              network and operator time. Priced on decimal terabytes (1 TB =
              10¹² bytes). Provider rates as of {RATES_AS_OF}.
            </p>
          </div>
        )}
      </CardContent>

      <CardFooter className="border-t pt-4">
        <p className="text-sm text-muted-foreground">
          Every disk added here is capacity nobody pays for twice.
        </p>
      </CardFooter>
    </Card>
  );
}
