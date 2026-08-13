'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  CLUSTER_EVENT_CATEGORIES,
  CLUSTER_EVENT_SEVERITIES,
  type ClusterEventCategory,
  type ClusterEventSeverity,
} from '@garage-ware/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { nodeLabel } from '@/lib/node-label';

/** Sentinel for "no node" — Radix Select forbids an empty value. */
const NO_NODE = '__cluster__';

/** What a caller may fill in for the admin. */
export interface LogEventPrefill {
  nodeId?: string;
  title?: string;
  detail?: string;
  severity?: ClusterEventSeverity;
  category?: ClusterEventCategory;
}

export interface NodeChoice {
  nodeId: string;
  /** The node's name, or null when no `name:` tag supplies one. */
  name: string | null;
  zone: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: readonly NodeChoice[];
  /**
   * Applied as the *initial* state. The parent remounts this component with a
   * fresh `key` each time it opens the dialog, so the form resets from a new
   * prefill without an effect that writes state on mount — see the
   * `react-hooks/set-state-in-effect` rule.
   */
  prefill?: LogEventPrefill;
  /** Called after a successful write so the parent can refresh. */
  onLogged: () => void | Promise<void>;
}

const CATEGORY_LABELS: Record<ClusterEventCategory, string> = {
  'hardware-failure': 'Hardware failure',
  'disk-replaced': 'Disk replaced',
  maintenance: 'Maintenance',
  upgrade: 'Upgrade',
  incident: 'Incident',
  decommission: 'Decommission',
  other: 'Other',
};

/**
 * Write a note onto the cluster timeline.
 *
 * The detector can say a node's capacity changed; only a person can say the
 * drive failed and an RMA is out. That is the whole job here — and the reason
 * the "still ongoing" checkbox matters more than it looks: an open note pinned
 * to a node is what puts that node in the **under repair** state on the events
 * page, so leaving it checked is how an operator marks a node as being worked
 * on, and closing the note later is what clears it.
 *
 * `occurred_at` is editable because a note is usually written after the fact.
 * The timeline sorts on it, so a note about last Tuesday lands on last Tuesday.
 */
export function LogEventDialog({
  open,
  onOpenChange,
  nodes,
  prefill,
  onLogged,
}: Props) {
  const [nodeId, setNodeId] = useState(prefill?.nodeId ?? NO_NODE);
  const [title, setTitle] = useState(prefill?.title ?? '');
  const [detail, setDetail] = useState(prefill?.detail ?? '');
  const [severity, setSeverity] = useState<ClusterEventSeverity>(
    prefill?.severity ?? 'info'
  );
  const [category, setCategory] = useState<ClusterEventCategory>(
    prefill?.category ?? 'other'
  );
  const [ongoing, setOngoing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // datetime-local wants a local wall clock with no zone, hence the manual
  // offset — toISOString() alone would shift the default by the UTC offset.
  const [occurredAt, setOccurredAt] = useState(() => {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      toast.error('Give the entry a title');
      return;
    }
    setSubmitting(true);
    try {
      const chosen = nodes.find((n) => n.nodeId === nodeId);
      await api('/next-api/garage/events', {
        method: 'POST',
        body: {
          title: title.trim(),
          detail: detail.trim() || undefined,
          nodeId: nodeId === NO_NODE ? undefined : nodeId,
          nodeZone: chosen?.zone || undefined,
          severity,
          category,
          occurredAt: new Date(occurredAt).toISOString(),
          // Empty means open, which is what marks a node under repair.
          endedAt: ongoing ? '' : new Date(occurredAt).toISOString(),
        },
      });
      toast.success('Logged to the timeline');
      onOpenChange(false);
      await onLogged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to log');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Log a cluster event</DialogTitle>
            <DialogDescription>
              Anything the scraper cannot see for itself — a failed drive, a
              maintenance window, why a capacity changed.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="event-title">Title</Label>
              <Input
                id="event-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Data drive failed on vault-01"
                maxLength={200}
                autoFocus
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="event-node">Node</Label>
                <Select value={nodeId} onValueChange={setNodeId}>
                  <SelectTrigger id="event-node">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_NODE}>Whole cluster</SelectItem>
                    {nodes.map((n) => (
                      <SelectItem key={n.nodeId} value={n.nodeId}>
                        {nodeLabel(n.name, n.nodeId)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-when">When</Label>
                <Input
                  id="event-when"
                  type="datetime-local"
                  value={occurredAt}
                  onChange={(e) => setOccurredAt(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="event-category">Category</Label>
                <Select
                  value={category}
                  onValueChange={(v) => setCategory(v as ClusterEventCategory)}
                >
                  <SelectTrigger id="event-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLUSTER_EVENT_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {CATEGORY_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-severity">Severity</Label>
                <Select
                  value={severity}
                  onValueChange={(v) => setSeverity(v as ClusterEventSeverity)}
                >
                  <SelectTrigger id="event-severity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLUSTER_EVENT_SEVERITIES.map((sv) => (
                      <SelectItem key={sv} value={sv}>
                        {sv[0].toUpperCase() + sv.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-detail">Detail</Label>
              <Textarea
                id="event-detail"
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                placeholder="Serial, ticket number, what was done…"
                maxLength={2000}
                rows={4}
              />
            </div>

            <div className="flex items-start gap-2">
              <Checkbox
                id="event-ongoing"
                checked={ongoing}
                onCheckedChange={(v) => setOngoing(v === true)}
              />
              <div className="grid gap-1 leading-none">
                <Label htmlFor="event-ongoing" className="cursor-pointer">
                  Still ongoing
                </Label>
                <p className="text-xs text-muted-foreground">
                  {nodeId === NO_NODE
                    ? 'Leaves the entry open until you close it.'
                    : 'Leaves the entry open and shows this node as under repair until you close it.'}
                </p>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Logging…' : 'Log event'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
