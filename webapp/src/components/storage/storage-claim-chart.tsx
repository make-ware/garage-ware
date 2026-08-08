'use client';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatStorage } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The "Storage claim" card's chart.
 *
 * Two stacked bars **on one shared scale**, so they can be read against each
 * other by eye:
 *
 *   Granted     [ claimed ][ received ][ given away ]   ← where it came from
 *   Allocated   [ stored ][ reserved ][ unallocated  ]  ← where it went
 *
 * Row 1 spans `claims + received` (the gross); row 2 spans the grant, or the
 * allocation where that is larger. The difference between the two row lengths
 * *is* the storage handed to other users — that visual gap is the point, and
 * it is why both rows share one scale rather than each normalising to its own
 * 100%.
 *
 * Presentation only. Every figure comes from `getUserStorageSummary()` via
 * `/next-api/garage/storage-summary`; nothing here re-derives net granted,
 * available, or allocated — see the storage-accounting section of CLAUDE.md
 * for why that arithmetic has exactly one implementation.
 */

/** A drawn slice of a bar. `gb` is the true ledger figure the legend states. */
export interface ClaimBarSegment {
  key: string;
  label: string;
  /** The amount this segment stands for, as the legend reports it. */
  gb: number;
  /** Width on the shared scale. Differs from `gb` only for carved segments. */
  widthGb: number;
  /** Legend sign. 'add' prefixes +, 'subtract' prefixes −, 'none' neither. */
  sign: 'add' | 'subtract' | 'none';
  /** CSS custom property holding this segment's fill. */
  fillVar: string;
  /** Sentence shown on hover/focus. */
  hint: string;
}

export interface ClaimBars {
  /** Shared denominator for both rows. Never 0 — callers divide by it. */
  scaleMax: number;
  sources: ClaimBarSegment[];
  allocation: ClaimBarSegment[];
}

export interface ClaimBarInput {
  claimsGb: number;
  receivedGb: number;
  sentGb: number;
  netGrantedGb: number;
  allocatedGb: number;
  storedGb: number;
}

/** Negative or non-finite figures are a bug upstream; draw them as nothing. */
function safe(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Lay both rows out on one scale.
 *
 * The subtle part is `sent`. It is a deduction, not a source, so it cannot
 * simply stack on top of claims and received — that would draw a bar longer
 * than the user's gross. Instead the colour is *carved off the tail* of the
 * source stack: the coloured run always measures exactly `netGranted`, and the
 * grey run past it is what left. So a segment's drawn width can be shorter
 * than the `gb` its legend row states, which is why the two are separate
 * fields — the legend reports the ledger, the bar reports the position.
 */
export function buildClaimBars(input: ClaimBarInput): ClaimBars {
  const claims = safe(input.claimsGb);
  const received = safe(input.receivedGb);
  const sent = safe(input.sentGb);
  const netGranted = safe(input.netGrantedGb);
  const allocated = safe(input.allocatedGb);
  const stored = safe(input.storedGb);

  const sources: ClaimBarSegment[] = [];
  // Carve the sources down to netGranted, oldest source first, so the grey
  // "given away" run lands at the tail where it reads as capacity leaving.
  let room = netGranted;
  const take = (amount: number) => {
    const width = Math.min(amount, room);
    room -= width;
    return width;
  };

  if (claims > 0) {
    sources.push({
      key: 'claimed',
      label: 'Claimed',
      gb: claims,
      widthGb: take(claims),
      sign: 'none',
      fillVar: '--gw-claimed',
      hint: 'Granted to you by an administrator, across the cluster nodes still in the layout.',
    });
  }
  if (received > 0) {
    sources.push({
      key: 'received',
      label: 'Received',
      gb: received,
      widthGb: take(received),
      sign: 'add',
      fillVar: '--gw-received',
      hint: 'Transferred to you by other users. Counts towards your total wherever it came from.',
    });
  }
  if (sent > 0) {
    sources.push({
      key: 'given',
      label: 'Given away',
      gb: sent,
      widthGb: sent,
      sign: 'subtract',
      fillVar: '--gw-given',
      hint: 'Transferred to other users. Still on the ledger, but no longer yours to allocate.',
    });
  }

  // Row 2 carries no ledger figures — every part of it is derived from
  // allocated / stored / netGranted — so unlike row 1 the drawn width and the
  // legend value are always the same number, and the segments add up to the
  // row exactly. Two error states extend it: quotas reserving more than the
  // grant (an administrator clawed a claim back under live buckets), and bytes
  // stored past what the quotas reserve. Both are drawn, never clamped away.
  const allocation: ClaimBarSegment[] = [];
  const allocatedInGrant = Math.min(allocated, netGranted);
  const overAllocated = allocated - allocatedInGrant;
  const storedInGrant = Math.min(stored, allocatedInGrant);
  const reserved = allocatedInGrant - storedInGrant;
  const storedOverQuota = Math.max(stored - allocated, 0);
  const unallocated = Math.max(netGranted - allocated, 0);

  if (storedInGrant > 0) {
    allocation.push({
      key: 'stored',
      label: 'Stored',
      gb: storedInGrant,
      widthGb: storedInGrant,
      sign: 'none',
      fillVar: '--gw-stored',
      hint: 'Bytes actually held in your buckets right now.',
    });
  }
  if (reserved > 0) {
    allocation.push({
      key: 'reserved',
      label: 'Reserved',
      gb: reserved,
      widthGb: reserved,
      sign: 'none',
      fillVar: '--gw-reserved',
      hint: 'Reserved by your bucket quotas but not yet filled. Spoken for, not in use.',
    });
  }
  if (overAllocated > 0) {
    allocation.push({
      key: 'over-allocated',
      label: 'Over your grant',
      gb: overAllocated,
      widthGb: overAllocated,
      sign: 'none',
      fillVar: '--gw-over',
      hint: 'Your bucket quotas reserve more than you have been granted. Reduce a quota to clear it.',
    });
  }
  if (storedOverQuota > 0) {
    allocation.push({
      key: 'over-quota',
      label: 'Over quota',
      gb: storedOverQuota,
      widthGb: storedOverQuota,
      sign: 'none',
      fillVar: '--gw-over',
      hint: 'Stored beyond what your bucket quotas reserve. Raise a bucket quota or delete objects.',
    });
  }
  if (unallocated > 0) {
    allocation.push({
      key: 'unallocated',
      label: 'Unallocated',
      gb: unallocated,
      widthGb: unallocated,
      sign: 'none',
      fillVar: '--gw-track',
      hint: 'Yours, but not yet assigned to a bucket. Free to allocate or transfer.',
    });
  }

  const sum = (segments: ClaimBarSegment[]) =>
    segments.reduce((total, s) => total + s.widthGb, 0);

  return {
    // Guard the divisor: a user with nothing granted still renders the card.
    scaleMax: Math.max(sum(sources), sum(allocation), 1e-9),
    sources,
    allocation,
  };
}

function signed(segment: ClaimBarSegment): string {
  const amount = formatStorage(segment.gb);
  if (segment.sign === 'add') return `+${amount}`;
  if (segment.sign === 'subtract') return `−${amount}`;
  return amount;
}

/**
 * One row of the chart.
 *
 * Segments are separated by a 2px gap in the card's own surface colour rather
 * than by a stroke, so nothing but data carries ink. Labels live in the legend
 * — an interior stacked segment has no free end to hang text off, and a label
 * clipped by its own segment is worse than no label.
 */
function ClaimBar({
  segments,
  scaleMax,
  ariaLabel,
}: {
  segments: ClaimBarSegment[];
  scaleMax: number;
  ariaLabel: string;
}) {
  return (
    <div
      className="flex h-6 w-full gap-[2px] overflow-hidden rounded"
      role="img"
      aria-label={ariaLabel}
    >
      {segments.map((segment) => (
        <Tooltip key={segment.key}>
          <TooltipTrigger asChild>
            <div
              tabIndex={0}
              // min-w keeps a sliver visible and focusable; the legend carries
              // the value regardless, so a tooltip never gates a figure.
              className="h-full min-w-[3px] rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{
                width: `${(segment.widthGb / scaleMax) * 100}%`,
                background: `var(${segment.fillVar})`,
              }}
            />
          </TooltipTrigger>
          <TooltipContent className="max-w-[15rem]">
            <p className="font-medium">
              {segment.label} — {signed(segment)}
            </p>
            <p className="opacity-80">{segment.hint}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * Legend and table view in one: every drawn segment, named and valued.
 *
 * It carries no total. The row's headline sits in {@link ClaimRow}'s heading
 * instead, because the segments listed here always add up to the *row*, which
 * is not always the same figure as the row's headline — an over-allocated row
 * spans the allocation, an ordinary one spans the grant. A total sitting at
 * the end of this list would invite adding it to them.
 */
function ClaimLegend({ segments }: { segments: ClaimBarSegment[] }) {
  return (
    <dl className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {segments.map((segment) => (
        <div key={segment.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-[2px]"
            style={{ background: `var(${segment.fillVar})` }}
          />
          <dt className="text-muted-foreground">{segment.label}</dt>
          <dd className="font-medium tabular-nums">{signed(segment)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A heading, its bar, and its legend — the unit both rows are built from. */
function ClaimRow({
  heading,
  total,
  totalLabel,
  segments,
  scaleMax,
  ariaLabel,
}: {
  heading: string;
  total?: number;
  totalLabel?: string;
  segments: ClaimBarSegment[];
  scaleMax: number;
  ariaLabel: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-4 text-xs">
        <span className="font-medium text-muted-foreground">{heading}</span>
        {total !== undefined && (
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground tabular-nums">
              {formatStorage(total)}
            </span>{' '}
            {totalLabel}
          </span>
        )}
      </div>
      <ClaimBar segments={segments} scaleMax={scaleMax} ariaLabel={ariaLabel} />
      <ClaimLegend segments={segments} />
    </div>
  );
}

export interface StorageClaimChartProps extends ClaimBarInput {
  /** Rendered under the headline figure; omitted when there are no buckets. */
  bucketCount?: number;
  className?: string;
}

export function StorageClaimChart({
  claimsGb,
  receivedGb,
  sentGb,
  netGrantedGb,
  allocatedGb,
  storedGb,
  bucketCount,
  className,
}: StorageClaimChartProps) {
  const bars = buildClaimBars({
    claimsGb,
    receivedGb,
    sentGb,
    netGrantedGb,
    allocatedGb,
    storedGb,
  });

  const netGranted = safe(netGrantedGb);
  const allocated = safe(allocatedGb);
  const available = Math.max(netGranted - allocated, 0);
  const stored = safe(storedGb);

  if (netGranted <= 0 && bars.sources.length === 0) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>
        You have no storage yet. Ask an administrator to grant you a claim, or
        have another user transfer you some, before creating buckets.
      </p>
    );
  }

  return (
    // The palette is declared here rather than in globals.css because it is
    // this chart's, not the app's. Both dark scopes are spelled out: the media
    // query covers the OS setting, `.dark` covers the in-app theme toggle.
    // Steps are the validated data-viz palette — blue/aqua for the two sources
    // (identity), a one-hue orange ramp for stored → reserved (an ordered
    // nesting, so lightness carries the order), neutrals for what is gone or
    // unspoken-for. Every pair clears the CVD and normal-vision gates against
    // this card's own surface; re-run the validator before changing a value.
    <div
      className={cn(
        'space-y-5',
        '[--gw-claimed:#2a78d6] [--gw-received:#1baf7a] [--gw-given:#94a3b8]',
        '[--gw-stored:#c14100] [--gw-reserved:#eb6834]',
        '[--gw-track:#e2e8f0] [--gw-over:#d03b3b]',
        'dark:[--gw-claimed:#3987e5] dark:[--gw-received:#199e70] dark:[--gw-given:#64748b]',
        'dark:[--gw-stored:#e76534] dark:[--gw-reserved:#a24d2e]',
        'dark:[--gw-track:#31415c]',
        className
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <div>
          <p className="text-3xl font-semibold leading-none">
            {formatStorage(netGranted)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">granted to you</p>
        </div>
        <div>
          <p className="text-xl font-semibold leading-none">
            {formatStorage(available)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">free to allocate</p>
        </div>
        <div>
          <p className="text-xl font-semibold leading-none">
            {formatStorage(stored)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            stored
            {bucketCount !== undefined && bucketCount > 0
              ? ` in ${bucketCount} bucket${bucketCount === 1 ? '' : 's'}`
              : ''}
          </p>
        </div>
      </div>

      <ClaimRow
        heading="Where it came from"
        segments={bars.sources}
        scaleMax={bars.scaleMax}
        ariaLabel={`Sources of your storage: ${bars.sources
          .map((s) => `${s.label} ${signed(s)}`)
          .join(', ')}. Granted to you: ${formatStorage(netGranted)}.`}
      />

      <ClaimRow
        heading="Where it went"
        total={allocated}
        totalLabel="allocated to buckets"
        segments={bars.allocation}
        scaleMax={bars.scaleMax}
        ariaLabel={`How your storage is used: ${bars.allocation
          .map((s) => `${s.label} ${signed(s)}`)
          .join(', ')}. Allocated to buckets: ${formatStorage(allocated)}.`}
      />
    </div>
  );
}
