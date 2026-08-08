'use client';

import { cn } from '@/lib/utils';

/**
 * Shared quota-fill treatment.
 *
 * The `(87%)` suffix was copy-pasted across three pages and only the bucket
 * detail page ever coloured it, so the two tables that most needed to show
 * "this bucket is nearly full" were the two that showed it in muted grey. One
 * implementation, with the thresholds that already existed.
 */

/** Null when there is no cap to be a fraction of, or no reading to fill it. */
export function fillPct(
  used: number | undefined | null,
  cap: number | undefined | null
): number | null {
  if (used === undefined || used === null) return null;
  if (!cap || cap <= 0) return null;
  return (used / cap) * 100;
}

/** Thresholds lifted from the bucket detail page, the only place they existed. */
export function fillTextClass(pct: number | null): string | undefined {
  if (pct === null) return undefined;
  if (pct >= 90) return 'text-destructive';
  if (pct >= 70) return 'text-amber-600 dark:text-amber-500';
  return 'text-muted-foreground';
}

export function fillBarClass(pct: number | null): string {
  if (pct === null) return 'bg-muted-foreground/30';
  if (pct >= 90) return 'bg-destructive';
  if (pct >= 70) return 'bg-amber-500';
  return 'bg-primary';
}

/**
 * The percentage suffix, coloured at 70% and 90%. Renders nothing when there is
 * no cap — an uncapped bucket has no fill, which is not the same as 0%.
 */
export function QuotaFillPct({
  used,
  cap,
  className,
}: {
  used?: number | null;
  cap?: number | null;
  className?: string;
}) {
  const pct = fillPct(used, cap);
  if (pct === null) return null;
  return (
    <span className={cn('text-xs ml-1', fillTextClass(pct), className)}>
      ({Math.round(pct)}%)
    </span>
  );
}

/** A thin fill bar. Clamped at 100% so an over-quota bucket cannot overflow. */
export function QuotaFillBar({
  used,
  cap,
  className,
}: {
  used?: number | null;
  cap?: number | null;
  className?: string;
}) {
  const pct = fillPct(used, cap);
  if (pct === null) return null;
  return (
    <div
      className={cn(
        'h-1 w-full rounded-full bg-muted overflow-hidden',
        className
      )}
      role="presentation"
    >
      <div
        className={cn('h-full transition-all', fillBarClass(pct))}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}
