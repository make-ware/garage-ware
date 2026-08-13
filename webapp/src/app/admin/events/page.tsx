'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  MessageSquarePlus,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  CLUSTER_EVENT_CATEGORIES,
  CLUSTER_EVENT_KINDS,
  CLUSTER_EVENT_SEVERITIES,
  type ClusterEvent,
  type ClusterEventKind,
} from '@garage-ware/shared';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { NodeIdentity } from '@/components/cluster/node-identity';
import {
  LogEventDialog,
  type LogEventPrefill,
  type NodeChoice,
} from '@/components/admin/log-event-dialog';
import { api } from '@/lib/api-client';
// Shared with the dashboard timeline so the two can't disagree about what a
// kind is called or what `warning` looks like.
import {
  CATEGORY_LABELS,
  KIND_LABELS,
  SEVERITY_TONE,
  eventBadgeLabel,
} from '@/lib/cluster-timeline';
import { formatCapacity, formatPbDateTime } from '@/lib/format';
import { buildNodeNameMap, nodeLabel } from '@/lib/node-label';
import pb from '@/lib/pocketbase';
import { fetchLatestNodeMetrics } from '@/lib/metrics/latest-node-metrics';
import {
  assessCoverage,
  coverageInputFromMetric,
  MIN_PEER_READINGS,
  type NodeCoverage,
} from '@/lib/metrics/data-coverage';
import type { ClusterEventsResponse, ClusterNodesResponse } from '@/lib/types';

const PER_PAGE = 50;
const ANY = '__any__';

/**
 * Which kinds carry byte counts in `previous_value` / `new_value`. The rows
 * store raw values so they stay re-renderable; this is where they become
 * readable, and it is the only place that decides.
 */
const BYTE_KINDS = new Set<ClusterEventKind>([
  'capacity_changed',
  'disk_changed',
  'data_drop',
  'node_added',
  'node_removed',
]);

type NodeState = 'online' | 'offline' | 'under-repair' | 'unknown';

const STATE_CHIP: Record<NodeState, string> = {
  online: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  offline: 'bg-destructive/10 text-destructive',
  'under-repair': 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  unknown: 'bg-muted text-muted-foreground',
};

const STATE_LABEL: Record<NodeState, string> = {
  online: 'Online',
  offline: 'Offline',
  'under-repair': 'Under repair',
  unknown: 'No samples',
};

interface NodeRow extends NodeChoice {
  state: NodeState;
  /** The open note holding this node in `under-repair`, for the tooltip. */
  openNote: string | null;
}

function formatValue(kind: ClusterEventKind, raw: string): string {
  if (!raw) return '—';
  if (!BYTE_KINDS.has(kind)) return raw;
  const n = Number(raw);
  return Number.isFinite(n) ? formatCapacity(n) : raw;
}

/** Local day key, so grouping matches the reader's calendar rather than UTC. */
function dayKey(iso: string): string {
  const d = new Date(iso.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? iso : d.toDateString();
}

function timeOf(iso: string): string {
  const d = new Date(iso.replace(' ', 'T'));
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function AdminEventsView() {
  const params = useSearchParams();

  const [nodeFilter, setNodeFilter] = useState(params.get('nodeId') ?? ANY);
  const [kindFilter, setKindFilter] = useState(params.get('kind') ?? ANY);
  const [severityFilter, setSeverityFilter] = useState(ANY);
  const [sourceFilter, setSourceFilter] = useState(ANY);
  const [categoryFilter, setCategoryFilter] = useState(ANY);
  const [page, setPage] = useState(1);

  const [data, setData] = useState<ClusterEventsResponse | null>(null);
  const [openNotes, setOpenNotes] = useState<ClusterEvent[]>([]);
  const [nodes, setNodes] = useState<ClusterNodesResponse | null>(null);
  const [coverage, setCoverage] = useState<NodeCoverage[]>([]);
  /** The cluster expectation each flagged node is short of. */
  const [coverageMedian, setCoverageMedian] = useState<number | null>(null);
  const [coverageGuard, setCoverageGuard] = useState<string | null>(null);
  const [nodeStates, setNodeStates] = useState<Map<string, NodeState>>(
    () => new Map()
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [logOpen, setLogOpen] = useState(false);
  const [prefill, setPrefill] = useState<LogEventPrefill | undefined>();
  // Bumped on every open so the dialog remounts and re-reads its prefill as
  // initial state. Resetting it from an effect instead would be a setState in
  // an effect body, which the lint rule rejects — and rightly: this is state
  // that belongs to one showing of the form, not something to synchronize.
  const [logKey, setLogKey] = useState(0);
  const [annotating, setAnnotating] = useState<string | null>(null);
  const [annotationText, setAnnotationText] = useState('');

  const nodeNames = useMemo(() => buildNodeNameMap(nodes?.items), [nodes]);

  const query = useMemo(() => {
    const q = new URLSearchParams({
      page: String(page),
      perPage: String(PER_PAGE),
    });
    if (nodeFilter !== ANY) q.set('nodeId', nodeFilter);
    if (kindFilter !== ANY) q.set('kind', kindFilter);
    if (severityFilter !== ANY) q.set('severity', severityFilter);
    if (sourceFilter !== ANY) q.set('source', sourceFilter);
    if (categoryFilter !== ANY) q.set('category', categoryFilter);
    return q.toString();
  }, [
    page,
    nodeFilter,
    kindFilter,
    severityFilter,
    sourceFilter,
    categoryFilter,
  ]);

  // Filters and page live in state, so the effect re-runs on every change and
  // is the only place that fetches the timeline — no separate refresh() to
  // drift out of step with the filters.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const resp = await api<ClusterEventsResponse>(
          `/next-api/garage/events?${query}`
        );
        if (cancelled) return;
        setData(resp);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [query, refreshKey]);

  // Node identity, live state, the open notes that mark a node under repair,
  // and the coverage suggestions — all unfiltered, because the strip at the top
  // of the page describes the cluster, not the current filter.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const [nodesResp, notesResp] = await Promise.all([
          api<ClusterNodesResponse>('/next-api/garage/cluster/nodes').catch(
            () => null
          ),
          api<ClusterEventsResponse>(
            '/next-api/garage/events?source=manual&perPage=200'
          ),
        ]);
        if (cancelled) return;
        setNodes(nodesResp);
        setOpenNotes(notesResp.items.filter((e) => !e.ended_at));

        const ids = (nodesResp?.items ?? []).map((n) => n.id);
        if (ids.length === 0) return;
        const latest = await fetchLatestNodeMetrics(pb, ids);
        if (cancelled) return;

        const states = new Map<string, NodeState>();
        for (const id of ids) {
          const row = latest.get(id);
          states.set(id, !row ? 'unknown' : row.is_up ? 'online' : 'offline');
        }
        setNodeStates(states);

        // The same judgement /dashboard/metrics renders, from the same
        // function — a suggestion here, never an auto-written row, because it
        // re-decides every scrape and would otherwise append itself forever.
        const result = assessCoverage(
          [...latest.values()].map(coverageInputFromMetric)
        );
        setCoverage(result.flagged);
        setCoverageMedian(result.medianBytesPerPartition);
        setCoverageGuard(
          result.guard === 'too-few-peers'
            ? `Comparing data per partition needs at least ${MIN_PEER_READINGS} storage nodes reporting; ${result.contributingNodes} ${result.contributingNodes === 1 ? 'is' : 'are'}. Nothing can be suggested from it yet.`
            : result.guard === 'cluster-too-empty'
              ? 'The cluster holds too little data per partition for the comparison to mean anything yet. Nothing can be suggested from it.'
              : null
        );
      } catch {
        // The timeline is the page; identity, state and suggestions are
        // enrichment. This is the page an operator opens *because* the cluster
        // looks sick, so an unreachable Garage must cost the labels, not the log.
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  /** node_id → the open note holding it under repair. */
  const repairByNode = useMemo(() => {
    const map = new Map<string, ClusterEvent>();
    for (const note of openNotes) {
      if (note.node_id && !map.has(note.node_id)) map.set(note.node_id, note);
    }
    return map;
  }, [openNotes]);

  const nodeRows = useMemo<NodeRow[]>(
    () =>
      (nodes?.items ?? [])
        .map((n) => {
          const repair = repairByNode.get(n.id);
          return {
            nodeId: n.id,
            name: nodeNames.get(n.id) ?? null,
            zone: n.zone,
            state: repair
              ? ('under-repair' as NodeState)
              : (nodeStates.get(n.id) ?? 'unknown'),
            openNote: repair?.title ?? null,
          };
        })
        .sort((a, b) =>
          nodeLabel(a.name, a.nodeId).localeCompare(nodeLabel(b.name, b.nodeId))
        ),
    [nodes, nodeNames, nodeStates, repairByNode]
  );

  const changeFilter = useCallback(
    (setter: (value: string) => void) => (value: string) => {
      setter(value);
      setPage(1);
    },
    []
  );

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const days = useMemo(() => {
    const grouped: Array<{ day: string; items: ClusterEvent[] }> = [];
    for (const item of data?.items ?? []) {
      const key = dayKey(item.occurred_at);
      const last = grouped[grouped.length - 1];
      if (last && last.day === key) last.items.push(item);
      else grouped.push({ day: key, items: [item] });
    }
    return grouped;
  }, [data]);

  const openLog = useCallback((next?: LogEventPrefill) => {
    setPrefill(next);
    setLogKey((k) => k + 1);
    setLogOpen(true);
  }, []);

  function suggestNote(n: NodeCoverage) {
    const label = nodeLabel(nodeNames.get(n.nodeId) ?? null, n.nodeId);
    openLog({
      nodeId: n.nodeId,
      title: `${label} is holding less data than its peers`,
      detail:
        `${formatCapacity(n.bytesPerPartition ?? 0)} per partition against a cluster median of ` +
        `${formatCapacity(coverageMedian ?? 0)}` +
        (n.missingBytes !== null
          ? `, about ${formatCapacity(n.missingBytes)} of block data unaccounted for`
          : '') +
        '. Detected by the data-coverage check; record what was actually wrong.',
      severity: n.severe ? 'critical' : 'warning',
      category: 'hardware-failure',
    });
  }

  async function saveAnnotation(id: string) {
    try {
      await api(`/next-api/garage/events/${id}`, {
        method: 'PATCH',
        body: { annotation: annotationText.trim() },
      });
      toast.success('Annotation saved');
      setAnnotating(null);
      setAnnotationText('');
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to annotate');
    }
  }

  async function closeEvent(id: string) {
    try {
      await api(`/next-api/garage/events/${id}`, {
        method: 'PATCH',
        body: { endedAt: new Date().toISOString() },
      });
      toast.success('Marked as resolved');
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to close');
    }
  }

  async function deleteEvent(id: string) {
    try {
      await api(`/next-api/garage/events/${id}`, { method: 'DELETE' });
      toast.success('Note deleted');
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  const totalPages = data?.totalPages ?? 1;
  const totalItems = data?.totalItems ?? 0;

  return (
    <div className="p-8 max-w-7xl">
      <div className="mb-2 flex items-start justify-between gap-4">
        <h1 className="text-3xl font-bold">Cluster events</h1>
        <Button size="sm" onClick={() => openLog()}>
          <Plus className="mr-1 h-4 w-4" />
          Log an event
        </Button>
      </div>
      <p className="text-muted-foreground mb-6">
        What changed in the cluster, and why. Layout changes, disk resizes and
        connectivity are detected automatically by diffing each 15-minute
        metrics scrape against the previous one — Garage keeps no history of
        itself, so a change only exists here if it was written down as it
        happened. Everything else is what an operator records by hand.
      </p>

      {error && <p className="text-destructive mb-4">{error}</p>}

      {nodeRows.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Nodes</CardTitle>
            <CardDescription>
              Connectivity is sampled every 15 minutes, so a state here can be
              up to one interval behind. &ldquo;Under repair&rdquo; is a node
              with an open note against it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {nodeRows.map((n) => (
                <div
                  key={n.nodeId}
                  className="flex items-center gap-3 rounded-md border px-3 py-2"
                  title={n.openNote ?? undefined}
                >
                  <NodeIdentity name={n.name} nodeId={n.nodeId} />
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${STATE_CHIP[n.state]}`}
                  >
                    {STATE_LABEL[n.state]}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {(coverage.length > 0 || coverageGuard) && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Suggested</CardTitle>
            <CardDescription>
              Comparative checks that re-decide on every scrape, so they are
              offered rather than logged. Record one only once you know what it
              was.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Never render nothing when a guard is what silenced the check —
                a silent all-clear is the failure this check exists to prevent. */}
            {coverage.length === 0 ? (
              <p className="text-sm text-muted-foreground">{coverageGuard}</p>
            ) : (
              coverage.map((n) => (
                <div
                  key={n.nodeId}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
                >
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      {nodeLabel(nodeNames.get(n.nodeId) ?? null, n.nodeId)} is{' '}
                      {(100 * (n.dataShortfallPct ?? 0)).toFixed(1)}% below the
                      cluster median
                    </p>
                    <p className="text-muted-foreground">
                      {formatCapacity(n.bytesPerPartition ?? 0)} per partition
                      vs {formatCapacity(coverageMedian ?? 0)}
                      {n.missingBytes !== null
                        ? ` · about ${formatCapacity(n.missingBytes)} unaccounted for`
                        : ''}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => suggestNote(n)}
                  >
                    Log this
                  </Button>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4 items-end">
            <div className="space-y-2">
              <Label>Node</Label>
              <Select
                value={nodeFilter}
                onValueChange={changeFilter(setNodeFilter)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Any node" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any node</SelectItem>
                  {nodeRows.map((n) => (
                    <SelectItem key={n.nodeId} value={n.nodeId}>
                      {nodeLabel(n.name, n.nodeId)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Kind</Label>
              <Select
                value={kindFilter}
                onValueChange={changeFilter(setKindFilter)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Any kind" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any kind</SelectItem>
                  {CLUSTER_EVENT_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Severity</Label>
              <Select
                value={severityFilter}
                onValueChange={changeFilter(setSeverityFilter)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Any severity" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any severity</SelectItem>
                  {CLUSTER_EVENT_SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s[0].toUpperCase() + s.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Source</Label>
              <Select
                value={sourceFilter}
                onValueChange={changeFilter(setSourceFilter)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Any source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any source</SelectItem>
                  <SelectItem value="detector">Detected</SelectItem>
                  <SelectItem value="manual">Written by hand</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select
                value={categoryFilter}
                onValueChange={changeFilter(setCategoryFilter)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Any category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any category</SelectItem>
                  {CLUSTER_EVENT_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                setNodeFilter(ANY);
                setKindFilter(ANY);
                setSeverityFilter(ANY);
                setSourceFilter(ANY);
                setCategoryFilter(ANY);
                setPage(1);
              }}
            >
              Clear filters
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>
            {totalItems} entr{totalItems === 1 ? 'y' : 'ies'}
            {totalPages > 1
              ? ` · page ${data?.page ?? 1} of ${totalPages}`
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : days.length === 0 ? (
            <p className="text-muted-foreground">
              Nothing recorded for these filters. Detected events appear after
              the second metrics scrape — the first one has nothing to compare
              against.
            </p>
          ) : (
            <>
              <div className="space-y-6">
                {days.map(({ day, items }) => (
                  <div key={day}>
                    <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                      {day}
                    </h3>
                    <ul className="space-y-3">
                      {items.map((e) => (
                        <li key={e.id} className="flex gap-3">
                          <div
                            className={`mt-1 w-1 shrink-0 rounded-full ${SEVERITY_TONE[e.severity] ?? SEVERITY_TONE.info}`}
                            aria-hidden
                          />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                                {timeOf(e.occurred_at)}
                              </span>
                              {/* A manual row's kind is always "Note", which
                                  paired with a "by hand" badge said nothing
                                  twice; its category is the useful word. */}
                              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                                {eventBadgeLabel(e)}
                              </span>
                              {!e.ended_at && e.source === 'manual' && (
                                <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                                  open
                                </span>
                              )}
                              <span className="font-medium">{e.title}</span>
                            </div>

                            {e.node_id && (
                              <NodeIdentity
                                name={nodeNames.get(e.node_id) ?? null}
                                nodeId={e.node_id}
                                className="text-sm"
                              />
                            )}

                            {(e.previous_value || e.new_value) && (
                              <p className="font-mono text-xs text-muted-foreground">
                                {formatValue(e.kind, e.previous_value ?? '')}
                                {' → '}
                                {formatValue(e.kind, e.new_value ?? '')}
                              </p>
                            )}

                            {e.detail && (
                              <p className="text-sm text-muted-foreground">
                                {e.detail}
                              </p>
                            )}

                            {e.annotation && (
                              <div className="rounded-md border-l-2 border-muted-foreground/30 bg-muted/40 px-3 py-2 text-sm">
                                <p>{e.annotation}</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {e.annotated_by}
                                  {e.annotated_at
                                    ? ` · ${formatPbDateTime(e.annotated_at)}`
                                    : ''}
                                </p>
                              </div>
                            )}

                            {annotating === e.id ? (
                              <div className="space-y-2">
                                <Textarea
                                  value={annotationText}
                                  onChange={(ev) =>
                                    setAnnotationText(ev.target.value)
                                  }
                                  placeholder="What was actually going on here?"
                                  maxLength={2000}
                                  rows={3}
                                />
                                <div className="flex gap-2">
                                  <Button
                                    size="sm"
                                    onClick={() => saveAnnotation(e.id)}
                                  >
                                    Save
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setAnnotating(null)}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => {
                                    setAnnotating(e.id);
                                    setAnnotationText(e.annotation ?? '');
                                  }}
                                >
                                  <MessageSquarePlus className="mr-1 h-3 w-3" />
                                  {e.annotation ? 'Edit note' : 'Annotate'}
                                </Button>
                                {e.source === 'manual' && !e.ended_at && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => closeEvent(e.id)}
                                  >
                                    Mark resolved
                                  </Button>
                                )}
                                {e.source === 'manual' && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-xs text-destructive"
                                    onClick={() => deleteEvent(e.id)}
                                  >
                                    <Trash2 className="mr-1 h-3 w-3" />
                                    Delete
                                  </Button>
                                )}
                              </div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              {totalPages > 1 && (
                <div className="mt-6 flex items-center justify-between">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="mr-1 h-4 w-4" />
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {data?.page ?? 1} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                    <ChevronRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <LogEventDialog
        key={logKey}
        open={logOpen}
        onOpenChange={setLogOpen}
        nodes={nodeRows}
        prefill={prefill}
        onLogged={refresh}
      />
    </div>
  );
}

export default function AdminEventsPage() {
  return (
    <Suspense fallback={<div className="p-8">Loading...</div>}>
      <AdminEventsView />
    </Suspense>
  );
}
