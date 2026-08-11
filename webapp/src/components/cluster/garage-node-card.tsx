'use client';

import { Badge } from '@/components/ui/badge';
import { QuotaFillBar, QuotaFillPct } from '@/components/storage/quota-fill';
import { formatCapacity } from '@/lib/format';
import { cn } from '@/lib/utils';
import { nodeLabel, parseNodeTags } from '@/lib/node-label';
import type { ClusterNodeItem } from '@/lib/types';

/**
 * One Garage node as a clickable card, opening the details dialog. It is a
 * real <button>, so keyboard and screen-reader behaviour comes for free — the
 * previous card had to fake both because React Flow owned the click.
 *
 * The card sizes itself from its content inside the zone's grid track; it must
 * stay compact, since everything else lives in the dialog.
 *
 * Two capacities, because they answer different questions and routinely
 * disagree: "layout" is the capacity declared in the Garage layout (what the
 * cluster will place against, and what claims are valued from), "reported" is
 * the size the node's data partition actually reports. The fill percentage
 * belongs to the reported figure — it is the only one with real bytes behind
 * it. Exact used/total pairs stay in the dialog.
 */
function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate tabular-nums">{children}</span>
    </div>
  );
}

interface GarageNodeCardProps {
  item: ClusterNodeItem;
  selected: boolean;
  onSelect: (nodeId: string) => void;
}

export function GarageNodeCard({
  item,
  selected,
  onSelect,
}: GarageNodeCardProps) {
  const diskUsed =
    item.diskTotalBytes !== null && item.diskFreeBytes !== null
      ? item.diskTotalBytes - item.diskFreeBytes
      : null;
  const status =
    item.isUp === null
      ? { dot: 'bg-muted-foreground', label: 'status unknown' }
      : item.isUp
        ? { dot: 'bg-emerald-500', label: 'up' }
        : { dot: 'bg-destructive', label: 'down' };
  // `rest` drops the tag that supplied the name, so it never shows twice —
  // and, since the badges are capped at three, so a name badge cannot evict a
  // real tag like `ssd`. The aria-label uses the full id when unnamed: some
  // screen readers announce a trailing ellipsis.
  const { name, rest } = parseNodeTags(item.tags);
  return (
    <button
      type="button"
      aria-label={`Node ${name ?? item.id} details`}
      onClick={() => onSelect(item.id)}
      className={cn(
        'w-full min-w-0 overflow-hidden rounded-md border bg-card p-3 text-left text-card-foreground shadow-sm transition-colors',
        'hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'border-primary ring-1 ring-primary'
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn('h-2 w-2 shrink-0 rounded-full', status.dot)}
          title={status.label}
        />
        <span className="truncate text-sm font-medium">
          {nodeLabel(name, item.id)}
        </span>
        {item.draining && (
          <Badge
            variant="outline"
            className="shrink-0 border-amber-500/60 text-[10px] text-amber-500"
          >
            draining
          </Badge>
        )}
      </div>

      <div className="mt-2 space-y-0.5">
        <Stat label="Layout">
          {item.capacity !== null ? (
            formatCapacity(item.capacity)
          ) : (
            <span className="text-muted-foreground">gateway</span>
          )}
        </Stat>
        <Stat label="Reported">
          {item.diskTotalBytes !== null ? (
            <>
              {formatCapacity(item.diskTotalBytes)}
              <QuotaFillPct used={diskUsed} cap={item.diskTotalBytes} />
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Stat>
      </div>

      <QuotaFillBar
        used={diskUsed}
        cap={item.diskTotalBytes}
        className="mt-2"
      />

      {rest.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 overflow-hidden">
          {rest.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[10px]">
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </button>
  );
}
