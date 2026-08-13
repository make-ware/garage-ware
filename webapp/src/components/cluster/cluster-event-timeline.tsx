'use client';

import { useMemo } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { NodeIdentity } from '@/components/cluster/node-identity';
import {
  SEVERITY_LABEL,
  SEVERITY_TONE,
  TIMELINE_DAYS,
  eventBadgeLabel,
  groupEventsByWeek,
} from '@/lib/cluster-timeline';
import { formatPbDateTime } from '@/lib/format';
import type { ClusterTimelineEvent } from '@/lib/types';
import { cn } from '@/lib/utils';

interface ClusterEventTimelineProps {
  events: ClusterTimelineEvent[] | null;
  /** node id → name from its `name:` tag, or null. Resolved from the layout. */
  nodeNames: Map<string, string | null>;
  loading: boolean;
  /** Set when the fetch failed. The map is the page; this is enrichment. */
  error: string | null;
  /** Rows in the window, which may exceed `events.length`. */
  totalItems: number;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

function EventRow({
  event,
  nodeNames,
}: {
  event: ClusterTimelineEvent;
  nodeNames: Map<string, string | null>;
}) {
  const ongoing = event.source === 'manual' && !event.ended_at;
  return (
    <li className="relative pl-6">
      <span
        className={cn(
          'absolute left-0 top-1.5 h-2 w-2 -translate-x-1/2 rounded-full',
          SEVERITY_TONE[event.severity] ?? SEVERITY_TONE.info
        )}
        aria-hidden
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <time
          dateTime={event.occurred_at}
          className="font-mono text-xs tabular-nums text-muted-foreground"
        >
          {formatPbDateTime(event.occurred_at)}
        </time>
        <Chip>{eventBadgeLabel(event)}</Chip>
        {ongoing && <Chip>ongoing</Chip>}
      </div>
      <p className="mt-0.5 text-sm">
        {/* Severity reaches a screen reader in words; the dot is colour only. */}
        <span className="sr-only">
          {SEVERITY_LABEL[event.severity] ?? SEVERITY_LABEL.info}:{' '}
        </span>
        {event.title}
      </p>
      {event.node_id && (
        <NodeIdentity
          name={nodeNames.get(event.node_id) ?? null}
          nodeId={event.node_id}
          className="mt-1 text-sm text-muted-foreground"
        />
      )}
    </li>
  );
}

/**
 * What changed in the cluster lately, for the people looking at it.
 *
 * Renders, never fetches — the same split as `ClusterMap`, so the page owns
 * the request and this owns the shape.
 *
 * Only weeks with something in them get a marker — see `groupEventsByWeek`.
 * The window is stated once in the card's description rather than re-asserted
 * by a run of empty weeks.
 *
 * A node with no name — including one that has left the layout, which is
 * exactly what a `node_removed` row describes — falls back to its short id
 * through `NodeIdentity`. That is the honest answer, not a defect.
 */
export function ClusterEventTimeline({
  events,
  nodeNames,
  loading,
  error,
  totalItems,
}: ClusterEventTimelineProps) {
  const weeks = useMemo(
    () => (events ? groupEventsByWeek(events, new Date()) : []),
    [events]
  );
  const shown = events?.length ?? 0;
  const truncated = totalItems > shown;

  return (
    // Matches the zone boxes in `zone-group-card.tsx` — dashed, muted, flat —
    // so the timeline reads as part of the cluster view rather than a panel
    // floating above it. Keep the two in step if either changes.
    <Card className="rounded-lg border-dashed bg-muted/30 shadow-none">
      <CardHeader>
        <CardTitle>Cluster events</CardTitle>
        <CardDescription>
          Layout changes, disk swaps and connectivity over the last{' '}
          {TIMELINE_DAYS} days, newest first
          {truncated
            ? ` — showing the ${shown} most recent of ${totalItems}`
            : ''}
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : shown === 0 ? (
          <p className="text-sm text-muted-foreground">
            No changes recorded in the last {TIMELINE_DAYS} days.
          </p>
        ) : (
          <div className="space-y-6">
            {weeks.map((week) => (
              <section
                key={week.weekStart.toISOString()}
                aria-label={week.label}
                className="space-y-3"
              >
                <div className="flex items-center gap-3">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {week.label}
                  </h3>
                  <span className="h-px flex-1 bg-border" aria-hidden />
                </div>
                <ul className="space-y-4 border-l border-border py-1">
                  {week.items.map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      nodeNames={nodeNames}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
