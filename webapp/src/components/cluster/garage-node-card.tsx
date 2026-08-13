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
  /** An open manual note is pinned to this node — see CLAUDE.md, Cluster events. */
  underRepair?: boolean;
  onSelect: (nodeId: string) => void;
}

/**
 * The dot answers "how worried should I be", so it takes the worst of the two
 * signals it has: down beats under repair beats unknown beats up. Liveness
 * alone was misleading — a node with an open repair note showed the same green
 * as a healthy one, which is exactly the thing the note exists to say.
 *
 * Nothing is lost by the precedence: repair also renders as its own badge, so
 * a node that is both down and being worked on shows a red dot *and* the
 * badge, and the dot's title spells out both.
 */
function nodeStatus(isUp: boolean | null, underRepair: boolean) {
  const liveness = isUp === null ? 'status unknown' : isUp ? 'up' : 'down';
  const label = underRepair ? `${liveness} · under repair` : liveness;
  if (isUp === false) return { dot: 'bg-destructive', label };
  if (underRepair) return { dot: 'bg-amber-500', label };
  if (isUp === null) return { dot: 'bg-muted-foreground', label };
  return { dot: 'bg-emerald-500', label };
}

export function GarageNodeCard({
  item,
  selected,
  underRepair = false,
  onSelect,
}: GarageNodeCardProps) {
  const diskUsed =
    item.diskTotalBytes !== null && item.diskFreeBytes !== null
      ? item.diskTotalBytes - item.diskFreeBytes
      : null;
  const status = nodeStatus(item.isUp, underRepair);
  // `rest` drops the tag that supplied the name, so it never shows twice —
  // and, since the badges are capped at three, so a name badge cannot evict a
  // real tag like `ssd`.
  const { name, rest } = parseNodeTags(item.tags);
  return (
    <button
      type="button"
      // The label a node is *identified* by, never its full id: that id is the
      // key used to join a node to the cluster, and an aria-label is a display
      // surface like any other. An unnamed node announces its short id, which
      // may include a trailing ellipsis; that is the lesser cost.
      aria-label={`Node ${nodeLabel(name, item.id)} details`}
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
        {underRepair && (
          <Badge
            variant="outline"
            className="shrink-0 border-amber-500/60 text-[10px] text-amber-500"
          >
            under repair
          </Badge>
        )}
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
