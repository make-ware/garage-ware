'use client';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatPbDateTime } from '@/lib/format';
import {
  STALE_SCRUB_DAYS,
  isStale,
  type ScrubFreshness,
} from '@/lib/repair/scrub-freshness';

/**
 * When a node was last scrubbed — the one rendering of that verdict.
 *
 * It used to live inside the scrub page, which meant the repairs overview could
 * only have shown it by growing a second copy; the first thing that copy would
 * have lost is the distinction the original was written for. **A node that did
 * not answer, a node with no scrub worker, a scrub in progress, and a line we
 * could not parse are four different things, and none of them is "never
 * scrubbed."** The component takes a `ScrubFreshness` precisely so those stay
 * four branches rather than four falsy checks at the call site.
 *
 * It reads no clock: `describeScrubFreshness` is given `now` by the page, from
 * `fetchedAt`, so what is on screen is the age *as of the reading* rather than
 * as of the render.
 */
export function LastScrub({
  freshness,
  nextScheduledAt,
}: {
  freshness: ScrubFreshness;
  /** From the parsed scrub, when Garage says the next automatic pass is due. */
  nextScheduledAt?: string | null;
}) {
  return (
    <div>
      {freshness.kind === 'completed' ? (
        <>
          <div>{formatPbDateTime(freshness.iso)}</div>
          <div className="text-muted-foreground text-xs">
            {isStale(freshness) ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help text-amber-600 dark:text-amber-400">
                    {freshness.relative}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  {/* The threshold is rendered, not just applied: it is this
                      app's judgement — Garage scrubs "about once a month" and
                      states no interval — and a reader has to be able to
                      discount it. Amber at most; an overdue scrub is a thing to
                      look into, not a fault. */}
                  More than {STALE_SCRUB_DAYS} days ago. Garage normally scrubs
                  each node about once a month; this one looks overdue.
                </TooltipContent>
              </Tooltip>
            ) : (
              freshness.relative
            )}
          </div>
        </>
      ) : (
        <span className="text-muted-foreground">
          {freshness.kind === 'node-error'
            ? 'Node did not answer'
            : freshness.kind === 'no-worker'
              ? 'No scrub worker'
              : freshness.kind === 'in-progress'
                ? 'Scrub in progress'
                : freshness.kind === 'unrecognised'
                  ? 'Not reported'
                  : 'No date reported'}
        </span>
      )}
      {nextScheduledAt && (
        <div className="text-muted-foreground text-xs">
          next {formatPbDateTime(nextScheduledAt)}
        </div>
      )}
    </div>
  );
}
