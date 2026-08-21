'use client';

import { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { NodeIdentity } from '@/components/cluster/node-identity';
import { api } from '@/lib/api-client';
import { SEVERITY_LABEL, SEVERITY_TONE } from '@/lib/cluster-timeline';
import { formatPbDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ClusterEvent } from '@garage-ware/shared';
import type { ClusterEventsResponse } from '@/lib/types';

/** How many rows the card asks for. A log, not an archive — /admin/events is that. */
export const REPAIR_HISTORY_ROWS = 20;

interface Props {
  /** node key → name from its `name:` tag. Resolved live from the layout. */
  nodeNames: Map<string, string | null>;
  /** Bumped by the page after a launch or a retry, so a new row appears. */
  refreshToken?: number;
}

/**
 * What has been run from this app lately.
 *
 * **Its own card rather than `ClusterEventTimeline`.** That component takes
 * `ClusterTimelineEvent` — the *redacted projection* served to every signed-in
 * user, which by design drops `detail`, `new_value` and `actor_email`. Those
 * are exactly the three fields that make a repair history worth reading for an
 * admin: which operation, how many blocks, and who. Reusing it would mean
 * either showing none of that or widening the projection type, and the
 * projection is the privacy boundary, not the collection rule. It is also the
 * wrong shape (30-day calendar-week buckets over 20 rows) and the wrong badge:
 * `eventBadgeLabel` renders `category` for `action` rows, so every row here
 * would read "Maintenance".
 *
 * Every *primitive* is shared, though — severity tone and label from
 * `cluster-timeline.ts`, `<NodeIdentity>`, `formatPbDateTime` — so this card
 * cannot disagree with the timeline about what `warning` looks like.
 *
 * It fetches its own rows and swallows a failure into one muted line: this is
 * the last card on a page whose point is the controls above it.
 */
export function RepairHistoryCard({ nodeNames, refreshToken }: Props) {
  const [rows, setRows] = useState<ClusterEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const resp = await api<ClusterEventsResponse>(
          '/next-api/garage/events',
          { query: { kind: 'repair', perPage: REPAIR_HISTORY_ROWS } }
        );
        if (cancelled) return;
        setRows(resp.items);
        setFailed(false);
      } catch {
        if (cancelled) return;
        setRows(null);
        setFailed(true);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent repairs</CardTitle>
        <CardDescription>
          The last {REPAIR_HISTORY_ROWS} repair operations launched from this
          app, newest first. Read-only — the full timeline, with filters and
          notes, is on Admin → Events.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {failed ? (
          <p className="text-muted-foreground text-sm">
            Could not read the repair history.
          </p>
        ) : rows === null ? (
          <p className="text-muted-foreground text-sm">Loading...</p>
        ) : rows.length === 0 ? (
          // Not "no repairs": Garage's own automatic monthly scrub is not in
          // ClusterEvents and never will be, so claiming none have run would be
          // false on every healthy cluster.
          <p className="text-muted-foreground text-sm">
            No repairs have been launched from this app.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((event) => (
              <li key={event.id} className="relative pl-6">
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
                    className="text-muted-foreground font-mono text-xs tabular-nums"
                  >
                    {formatPbDateTime(event.occurred_at)}
                  </time>
                  <span className="text-sm">
                    {/* Colour is never the only carrier of severity. */}
                    <span className="sr-only">
                      {SEVERITY_LABEL[event.severity] ?? SEVERITY_LABEL.info}
                      :{' '}
                    </span>
                    {event.title}
                  </span>
                  {event.new_value && (
                    <span className="border-border text-muted-foreground rounded-full border px-1.5 py-0.5 font-mono text-[10px]">
                      {event.new_value}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3">
                  {event.node_id && (
                    <NodeIdentity
                      name={nodeNames.get(event.node_id) ?? null}
                      nodeId={event.node_id}
                      className="text-muted-foreground text-sm"
                    />
                  )}
                  {event.actor_email && (
                    <span className="text-muted-foreground text-xs">
                      {event.actor_email}
                    </span>
                  )}
                </div>
                {/* `detail` carries Garage's refusal on a failed row and the
                    re-queued count on a successful retry — and is empty on a
                    successful launch, which has nothing to add. So: rendered
                    whenever there is one, rather than gated on severity, which
                    would hide the one number a retry produces. */}
                {event.detail && (
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {event.detail}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
