'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, ListFilter } from 'lucide-react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { useIsMobile } from '@/hooks/use-mobile';
import { api, ApiError } from '@/lib/api-client';
import type {
  ClusterNodesResponse,
  MetricNode,
  MetricPoint,
  NodeMetricsHistory,
} from '@/lib/types';
import { formatCapacity } from '@/lib/format';
import {
  assessCoverage,
  bytesPerPartition,
  coverageInputFromPoint,
  latestPointsByNode,
  MIN_PEER_READINGS,
  type NodeCoverage,
} from '@/lib/metrics/data-coverage';
import { buildNodeNameMap, nodeKey, nodeLabel } from '@/lib/node-label';
import { cn } from '@/lib/utils';

const RANGES = ['6h', '24h', '7d', '30d'] as const;
type Range = (typeof RANGES)[number];

// The validated 8-slot categorical palette (see the dataviz reference
// palette): identical hues in both columns, each stepped for its surface.
// The ORDER is the CVD-safety mechanism — do not reorder or extend without
// re-running the validator; both columns pass every gate against this app's
// card surfaces (dark #0f172b, light #ffffff). Slots are assigned to nodes
// sorted by node_id, so a node keeps its color across ranges and reloads.
const PALETTE: Array<{ light: string; dark: string }> = [
  { light: '#2a78d6', dark: '#3987e5' }, // blue
  { light: '#eb6834', dark: '#d95926' }, // orange
  { light: '#1baf7a', dark: '#199e70' }, // aqua
  { light: '#eda100', dark: '#c98500' }, // yellow
  { light: '#e87ba4', dark: '#d55181' }, // magenta
  { light: '#008300', dark: '#008300' }, // green
  { light: '#4a3aa7', dark: '#9085e9' }, // violet
  { light: '#e34948', dark: '#e66767' }, // red
];

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/**
 * Chart series key for a node — CSS-var safe, since a node key is hex.
 *
 * The whole key, not a slice of it: two nodes sharing the first 8 characters
 * would otherwise share a colour slot.
 */
function nodeKeyFor(node: MetricNode): string {
  return `n${nodeKey(node.node_id)}`;
}

/**
 * Tooltip `content` that renders no card at all — what the charts use below
 * the mobile breakpoint.
 *
 * The card carries one row per charted node plus a detail line each, so on a
 * phone it covers the chart it is describing. Recharts draws the cursor from
 * the Tooltip element itself (`finalIsActive && <Cursor …>`), independent of
 * whatever `content` returns, so suppressing the card this way keeps the line
 * that tracks the touch along the series — the reader still gets a position,
 * just not eight values stacked over it.
 *
 * Declared at module scope so the prop identity is stable across renders.
 */
const noTooltipCard = () => null;

/** One row per time bucket, `${nodeKey}` → plotted value (absent = gap). */
type ChartRow = { t: number } & Record<string, number>;

/**
 * Pivot the long-format points into recharts rows for one metric. `pick`
 * returning null keeps the key off the row entirely, which recharts renders
 * as a gap (with connectNulls off) rather than a zero — the difference
 * between "no reading" and "queue is empty".
 */
function pivot(
  points: MetricPoint[],
  keyById: Map<string, string>,
  pick: (p: MetricPoint) => number | null,
  extras?: (p: MetricPoint) => Record<string, number> | null
): ChartRow[] {
  const byT = new Map<number, ChartRow>();
  for (const p of points) {
    const key = keyById.get(p.node_id);
    if (!key) continue;
    let row = byT.get(p.t);
    if (!row) {
      row = { t: p.t };
      byT.set(p.t, row);
    }
    const value = pick(p);
    if (value !== null) row[key] = value;
    if (extras) {
      const extra = extras(p);
      if (extra) {
        for (const [suffix, v] of Object.entries(extra)) {
          row[`${key}__${suffix}`] = v;
        }
      }
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

function usedPct(
  total: number | null,
  available: number | null
): number | null {
  if (total === null || total <= 0) return null;
  return (100 * (total - (available ?? 0))) / total;
}

interface MetricChartProps {
  title: string;
  description: string;
  data: ChartRow[];
  config: ChartConfig;
  nodeKeys: string[];
  range: Range;
  yDomain?: [number, number];
  /** Formats the plotted value in tooltips and the Y axis. */
  formatValue: (value: number) => string;
  /** Extra tooltip detail per series, from the row's `${key}__*` fields. */
  formatDetail?: (row: ChartRow, key: string) => string | null;
  /** stepAfter suits 0/100 uptime samples; monotone everything else. */
  curve?: 'monotone' | 'stepAfter';
}

function MetricChart({
  title,
  description,
  data,
  config,
  nodeKeys,
  range,
  yDomain,
  formatValue,
  formatDetail,
  curve = 'monotone',
}: MetricChartProps) {
  const isMobile = useIsMobile();

  const formatTick = (t: number) =>
    range === '6h' || range === '24h'
      ? new Date(t).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })
      : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });

  const tooltipCard = (
    <ChartTooltipContent
      labelFormatter={(_, payload) => {
        const t = payload?.[0]?.payload?.t;
        return typeof t === 'number'
          ? new Date(t).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '';
      }}
      formatter={(value, name, item) => {
        const key = String(name);
        const detail = formatDetail
          ? formatDetail(item.payload as ChartRow, key)
          : null;
        return (
          <div className="flex w-full items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: item.color }}
            />
            <span className="flex-1 text-muted-foreground">
              {config[key]?.label ?? key}
            </span>
            <span className="font-mono font-medium tabular-nums text-foreground">
              {formatValue(Number(value))}
              {detail ? (
                <span className="text-muted-foreground"> · {detail}</span>
              ) : null}
            </span>
          </div>
        );
      }}
    />
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            No data in this range.
          </p>
        ) : (
          <ChartContainer config={config} className="aspect-auto h-64 w-full">
            <LineChart data={data} margin={{ left: 4, right: 12, top: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickLine={false}
                axisLine={false}
                minTickGap={48}
                tickFormatter={formatTick}
              />
              <YAxis
                domain={yDomain ?? ['auto', 'auto']}
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(v: number) => formatValue(v)}
              />
              <ChartTooltip content={isMobile ? noTooltipCard : tooltipCard} />
              <ChartLegend
                content={<ChartLegendContent className="flex-wrap" />}
              />
              {nodeKeys.map((key) => (
                <Line
                  key={key}
                  dataKey={key}
                  type={curve}
                  stroke={`var(--color-${key})`}
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

interface NodeFilterProps {
  /** Every node the palette can chart — the filter's universe, not the shown set. */
  nodes: MetricNode[];
  nodeNames: Map<string, string>;
  /** The charts' own config, so a swatch here is the color of that node's line. */
  config: ChartConfig;
  hidden: ReadonlySet<string>;
  onToggle: (nodeId: string) => void;
  onOnly: (nodeId: string) => void;
  onAll: () => void;
  onNone: () => void;
}

/**
 * Multi-select over the charted nodes.
 *
 * Rows are plain `role="checkbox"` buttons rather than the `Checkbox`
 * component: each row also carries an "Only" action, and `Checkbox` is a
 * Radix `<button>`, so the two could not sit in one row without nesting
 * interactive elements. "Only" is always visible rather than revealed on
 * hover — a touch device has no hover, and this page is being fixed for one.
 */
function NodeFilter({
  nodes,
  nodeNames,
  config,
  hidden,
  onToggle,
  onOnly,
  onAll,
  onNone,
}: NodeFilterProps) {
  // ChartStyle emits `[data-chart=<id>] { --color-<key>: … }` (and a `.dark`
  // twin), so the swatches need their own scope id — the charts' vars are
  // scoped to their own containers and don't reach into a portalled popover.
  const styleId = `nodefilter-${useId().replace(/[^\w-]/g, '')}`;
  const shown = nodes.filter((n) => !hidden.has(n.node_id)).length;

  if (nodes.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <ListFilter className="h-4 w-4" />
          Nodes
          <span className="tabular-nums text-muted-foreground">
            {shown}/{nodes.length}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Charted nodes</span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onAll}
              disabled={shown === nodes.length}
            >
              All
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onNone}
              disabled={shown === 0}
            >
              None
            </Button>
          </div>
        </div>
        <div data-chart={styleId} className="max-h-72 overflow-y-auto p-1">
          <ChartStyle id={styleId} config={config} />
          {nodes.map((node) => {
            const key = nodeKeyFor(node);
            const checked = !hidden.has(node.node_id);
            const label = nodeLabel(
              nodeNames.get(node.node_id) ?? null,
              node.node_id
            );
            return (
              <div
                key={node.node_id}
                className="flex items-center gap-1 rounded-sm pr-1 hover:bg-accent"
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => onToggle(node.node_id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border',
                      checked
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input'
                    )}
                  >
                    {checked ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{
                      backgroundColor: `var(--color-${key})`,
                      opacity: checked ? 1 : 0.35,
                    }}
                  />
                  <span className="flex-1 truncate">{label}</span>
                  {node.node_zone ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {node.node_zone}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={() => onOnly(node.node_id)}
                  className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  Only
                </button>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MetricsView() {
  const { isAdmin } = useAdminStatus();
  const [range, setRange] = useState<Range>('24h');
  const [history, setHistory] = useState<NodeMetricsHistory | null>(null);
  const [nodeNames, setNodeNames] = useState<Map<string, string>>(
    () => new Map()
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scraping, setScraping] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // Which nodes the reader has switched *off*, rather than which are on: a
  // node that joins the cluster — or that only appears once a longer range is
  // picked — then charts by default, which is the safe direction for a page
  // whose job is to show you something is wrong.
  const [hiddenNodeIds, setHiddenNodeIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        // Node names live in the Garage layout, which this page's metrics come
        // nowhere near — NodeMetrics rows carry no tags. Fetched alongside and
        // allowed to fail: this is the page an operator opens when the cluster
        // looks sick, so an unreachable Garage must cost the labels, not the
        // charts.
        const [result, nodes] = await Promise.all([
          api<NodeMetricsHistory>('/next-api/garage/node-metrics', {
            query: { range },
          }),
          api<ClusterNodesResponse>('/next-api/garage/cluster/nodes').catch(
            () => null
          ),
        ]);
        if (cancelled) return;
        setHistory(result);
        setNodeNames(buildNodeNameMap(nodes?.items));
        setError(null);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [range, refreshKey]);

  const scrapeNow = async () => {
    setScraping(true);
    try {
      const result = await api<{
        recorded: number;
        statsFailed: number;
        events: { created: number; reopened: number; closed: number };
      }>('/next-api/garage/node-metrics/scrape', { method: 'POST' });
      // Logged and resolved are separate sentences to a reader: "2 logged" and
      // "1 resolved" are different news about a cluster, and a scrape that only
      // closed an outage would otherwise report nothing at all.
      const logged = result.events.created + result.events.reopened;
      const timeline = [
        logged > 0
          ? `${logged} cluster event${logged === 1 ? '' : 's'} logged`
          : '',
        result.events.closed > 0 ? `${result.events.closed} resolved` : '',
      ]
        .filter(Boolean)
        .join(', ');
      toast.success(
        `Recorded ${result.recorded} node sample${result.recorded === 1 ? '' : 's'}` +
          (result.statsFailed > 0
            ? ` (${result.statsFailed} without resync stats)`
            : '') +
          (timeline ? ` — ${timeline}` : '')
      );
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 503
          ? 'PocketBase is missing GARAGE_ADMIN_URL/GARAGE_ADMIN_TOKEN — the scraper cannot reach the cluster.'
          : err instanceof Error
            ? err.message
            : 'Scrape failed'
      );
    } finally {
      setScraping(false);
    }
  };

  // The API sorts nodes by node_id; slot i of the palette belongs to node i,
  // so colors are stable as long as the node set is. Nodes beyond the 8
  // validated slots are not charted (a 9th hue is never generated) — with
  // more than 8 nodes this page needs faceting instead.
  const nodes = useMemo(
    () => (history?.nodes ?? []).slice(0, PALETTE.length),
    [history]
  );
  const unchartedNodes = (history?.nodes.length ?? 0) - nodes.length;

  // Palette slots stay pinned to the charted list above, never to this one, so
  // switching a node off never repaints the lines that stayed on.
  const visibleNodes = useMemo(
    () => nodes.filter((n) => !hiddenNodeIds.has(n.node_id)),
    [nodes, hiddenNodeIds]
  );

  const keyById = useMemo(
    () => new Map(visibleNodes.map((n) => [n.node_id, nodeKeyFor(n)])),
    [visibleNodes]
  );
  const nodeKeys = useMemo(() => visibleNodes.map(nodeKeyFor), [visibleNodes]);

  const toggleNode = (nodeId: string) =>
    setHiddenNodeIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(nodeId)) next.add(nodeId);
      return next;
    });
  const showOnlyNode = (nodeId: string) =>
    setHiddenNodeIds(
      new Set(nodes.map((n) => n.node_id).filter((id) => id !== nodeId))
    );
  const showAllNodes = () => setHiddenNodeIds(new Set());
  const showNoNodes = () =>
    setHiddenNodeIds(new Set(nodes.map((n) => n.node_id)));

  // Over `nodes`, not `visibleNodes`: the slot a node gets must not depend on
  // what else is switched on, and the filter reads its swatches from here.
  const chartConfig = useMemo(() => {
    const config: ChartConfig = {};
    nodes.forEach((node, i) => {
      config[nodeKeyFor(node)] = {
        label: nodeLabel(nodeNames.get(node.node_id) ?? null, node.node_id),
        theme: PALETTE[i],
      };
    });
    return config;
  }, [nodes, nodeNames]);

  const points = useMemo(() => history?.points ?? [], [history]);

  const uptimeData = useMemo(
    () => pivot(points, keyById, (p) => p.uptime_pct),
    [points, keyById]
  );
  const dataSpaceData = useMemo(
    () =>
      pivot(
        points,
        keyById,
        (p) => usedPct(p.data_total_bytes, p.data_available_bytes),
        (p) =>
          p.data_total_bytes && p.data_total_bytes > 0
            ? {
                used: p.data_total_bytes - (p.data_available_bytes ?? 0),
                total: p.data_total_bytes,
              }
            : null
      ),
    [points, keyById]
  );
  const metaSpaceData = useMemo(
    () =>
      pivot(
        points,
        keyById,
        (p) => usedPct(p.meta_total_bytes, p.meta_available_bytes),
        (p) =>
          p.meta_total_bytes && p.meta_total_bytes > 0
            ? {
                used: p.meta_total_bytes - (p.meta_available_bytes ?? 0),
                total: p.meta_total_bytes,
              }
            : null
      ),
    [points, keyById]
  );
  // Bytes per partition: the series the coverage judgement is drawn from, so
  // the plotted line and the banner can never disagree. The extras carry the
  // partition count and — when the layout reported a partition size — the
  // fraction of the node's own allotment it has filled, which is the one
  // figure that stays meaningful on a cluster too small for the median guard.
  const perPartitionData = useMemo(
    () =>
      pivot(
        points,
        keyById,
        (p) => bytesPerPartition(coverageInputFromPoint(p)),
        (p) => {
          const partitions = p.stored_partitions;
          if (partitions === null || partitions <= 0) return null;
          const extra: Record<string, number> = { partitions };
          const size = p.partition_size_bytes;
          const total = p.data_total_bytes;
          if (size && size > 0 && total && total > 0) {
            const used = Math.max(total - (p.data_available_bytes ?? 0), 0);
            extra.allotment = (100 * used) / (partitions * size);
          }
          return extra;
        }
      ),
    [points, keyById]
  );
  const resyncQueueData = useMemo(
    () => pivot(points, keyById, (p) => p.resync_queue_length),
    [points, keyById]
  );
  const resyncErroredData = useMemo(
    () => pivot(points, keyById, (p) => p.resync_errored_blocks),
    [points, keyById]
  );

  // Deliberately over ALL points — neither the palette-capped `nodes` slice nor
  // the filter narrows it. A 9th node is not charted and a switched-off one is
  // not drawn, but both still have to be flagged: this banner is a health
  // alert, and a filter that could hide a wiped drive would defeat it.
  const coverage = useMemo(
    () =>
      assessCoverage(latestPointsByNode(points).map(coverageInputFromPoint)),
    [points]
  );

  const pct = (v: number) => `${v.toFixed(v >= 100 ? 0 : 1)}%`;
  const count = (v: number) => compactNumber.format(v);
  const spaceDetail = (row: ChartRow, key: string) => {
    const used = row[`${key}__used`];
    const total = row[`${key}__total`];
    if (used === undefined || total === undefined) return null;
    return `${formatCapacity(used)} / ${formatCapacity(total)}`;
  };

  const perPartitionDetail = (row: ChartRow, key: string) => {
    const partitions = row[`${key}__partitions`];
    if (partitions === undefined) return null;
    const shards = `${count(partitions)} partition${partitions === 1 ? '' : 's'}`;
    const allotment = row[`${key}__allotment`];
    return allotment === undefined
      ? shards
      : `${shards} · ${pct(allotment)} of allotment`;
  };

  const coverageNote = (n: NodeCoverage) => {
    if (n.status === 'rebuilding')
      return 'Its metadata is still catching up or a resync is running, so this should close on its own.';
    if (n.entriesPerPartition === null)
      return 'Resync stats were unavailable for this node, so a rebuild in progress cannot be ruled out — check it.';
    // A block shortfall well past the per-partition one means the node's own
    // metadata count is masking the hole; say so, since that is the reading an
    // operator would otherwise dismiss as a small-node artifact.
    const masked =
      n.blockShortfallPct !== null &&
      n.shortfallPct !== null &&
      n.blockShortfallPct > n.shortfallPct + 0.02;
    return (
      (masked
        ? 'It claims at least as many blocks as its peers but holds fewer bytes for each of them. '
        : '') +
      (n.severe
        ? 'Its metadata already covers these blocks and nothing is resynchronizing — run `garage repair blocks` on this node.'
        : 'Its metadata already covers these blocks and nothing is resynchronizing.')
    );
  };

  const guardNote =
    coverage.guard === 'too-few-peers'
      ? `Comparing data per partition needs at least ${MIN_PEER_READINGS} storage nodes reporting; ${coverage.contributingNodes} ${coverage.contributingNodes === 1 ? 'is' : 'are'}. Nothing here can be judged missing data.`
      : 'The cluster holds too little data per partition for the comparison to mean anything yet. Nothing here can be judged missing data.';

  const hasData = points.length > 0;

  return (
    <div className="container mx-auto max-w-6xl space-y-6 px-4 py-8">
      <Link
        href="/dashboard"
        className="text-sm text-muted-foreground hover:underline inline-flex items-center"
      >
        <ArrowLeft className="mr-1 h-4 w-4" /> Back to dashboard
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Cluster metrics</h1>
          <p className="text-sm text-muted-foreground">
            Per-node history, sampled every 15 minutes from the Garage admin
            API.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NodeFilter
            nodes={nodes}
            nodeNames={nodeNames}
            config={chartConfig}
            hidden={hiddenNodeIds}
            onToggle={toggleNode}
            onOnly={showOnlyNode}
            onAll={showAllNodes}
            onNone={showNoNodes}
          />
          <div className="flex rounded-md border">
            {RANGES.map((r) => (
              <Button
                key={r}
                variant={r === range ? 'secondary' : 'ghost'}
                size="sm"
                className="rounded-none first:rounded-l-md last:rounded-r-md"
                onClick={() => setRange(r)}
              >
                {r}
              </Button>
            ))}
          </div>
          {isAdmin && (
            <Button size="sm" onClick={scrapeNow} disabled={scraping}>
              {scraping ? 'Scraping…' : 'Scrape now'}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {unchartedNodes > 0 && (
        <p className="text-sm text-muted-foreground">
          Showing the first {PALETTE.length} of {history?.nodes.length} nodes —
          the color palette caps out; additional nodes are not charted.
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !hasData ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No samples recorded yet. Metrics appear after the first scheduled
            scrapes (every 15 minutes)
            {isAdmin
              ? ' — or use “Scrape now” to record one immediately.'
              : '.'}
          </CardContent>
        </Card>
      ) : (
        <>
          {coverage.flagged.length > 0 ? (
            <div className="space-y-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <p className="font-medium">
                {coverage.flagged.length === 1
                  ? '1 node is holding less data than its peers'
                  : `${coverage.flagged.length} nodes are holding less data than their peers`}
              </p>
              <ul className="space-y-1">
                {coverage.flagged.map((n) => (
                  <li key={n.nodeId}>
                    <span className="font-medium">
                      {nodeLabel(nodeNames.get(n.nodeId) ?? null, n.nodeId)}
                    </span>{' '}
                    is {pct(100 * (n.dataShortfallPct ?? 0))} below the cluster
                    median
                    {n.missingBytes !== null
                      ? ` — about ${formatCapacity(n.missingBytes)} of block data unaccounted for`
                      : ''}
                    .
                    <div className="opacity-90">
                      {formatCapacity(n.bytesPerPartition ?? 0)} per partition
                      vs {formatCapacity(coverage.medianBytesPerPartition ?? 0)}
                      {n.bytesPerEntry !== null &&
                      coverage.medianBytesPerEntry !== null ? (
                        <>
                          {' · '}
                          {formatCapacity(n.bytesPerEntry)} per claimed block vs{' '}
                          {formatCapacity(coverage.medianBytesPerEntry)}
                        </>
                      ) : null}
                    </div>
                    <div className="opacity-90">{coverageNote(n)}</div>
                  </li>
                ))}
              </ul>
            </div>
          ) : coverage.guard ? (
            // Never render nothing when a guard is what silenced the check —
            // a silent all-clear is the failure mode this exists to prevent.
            <p className="text-sm text-muted-foreground">{guardNote}</p>
          ) : null}

          {nodeKeys.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No nodes selected. Pick at least one under “Nodes” to chart it.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-6">
              <MetricChart
                title="Uptime"
                description="Share of samples in each interval where the node was connected"
                data={uptimeData}
                config={chartConfig}
                nodeKeys={nodeKeys}
                range={range}
                yDomain={[0, 100]}
                formatValue={pct}
                curve="stepAfter"
              />
              <MetricChart
                title="Data space used"
                description="Data partition fill per node (used / total in the tooltip)"
                data={dataSpaceData}
                config={chartConfig}
                nodeKeys={nodeKeys}
                range={range}
                yDomain={[0, 100]}
                formatValue={pct}
                formatDetail={spaceDetail}
              />
              <MetricChart
                title="Data per partition"
                description="Stored bytes divided by the partitions the layout assigns each node — equal-sized shards, so healthy nodes track each other. A line that drops away from the pack is a node missing data."
                data={perPartitionData}
                config={chartConfig}
                nodeKeys={nodeKeys}
                range={range}
                formatValue={formatCapacity}
                formatDetail={perPartitionDetail}
              />
              <MetricChart
                title="Metadata space used"
                description="Metadata partition fill per node (used / total in the tooltip)"
                data={metaSpaceData}
                config={chartConfig}
                nodeKeys={nodeKeys}
                range={range}
                yDomain={[0, 100]}
                formatValue={pct}
                formatDetail={spaceDetail}
              />
              <MetricChart
                title="Resync queue"
                description="Blocks waiting to resynchronize, per node"
                data={resyncQueueData}
                config={chartConfig}
                nodeKeys={nodeKeys}
                range={range}
                formatValue={count}
              />
              <MetricChart
                title="Resync errored blocks"
                description="Blocks whose resync is failing, per node"
                data={resyncErroredData}
                config={chartConfig}
                nodeKeys={nodeKeys}
                range={range}
                formatValue={count}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function MetricsPage() {
  return (
    <ProtectedRoute>
      <MetricsView />
    </ProtectedRoute>
  );
}
