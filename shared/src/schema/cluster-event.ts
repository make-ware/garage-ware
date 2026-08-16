import {
  baseSchema,
  DateField,
  defineCollection,
  SelectField,
  TextField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

/**
 * What a row records.
 *
 * The first ten are written by the detector in
 * pocketbase/pb_hooks/lib/cluster-events.js, which diffs each
 * `node-metrics-scrape` against the previous one. The last two are written by a
 * human: `note` is what an admin observed, `repair` is a repair operation an
 * admin launched through POST /next-api/garage/repairs.
 *
 * Deliberately absent: anything derived from the median comparison in
 * webapp/src/lib/metrics/data-coverage.ts. That check is *comparative* and
 * re-evaluates every scrape, so writing it here would append the same finding
 * every 15 minutes until someone fixed the node. It surfaces on /admin/events
 * as a suggestion instead, and becomes a `note` if a human agrees.
 */
export const CLUSTER_EVENT_KINDS = [
  /** The cluster layout version moved. One row per bump, not one per node. */
  'layout_version',
  /** A node gained a storage role. */
  'node_added',
  /** A node lost its role, or stopped being reported at all. */
  'node_removed',
  /** The capacity the layout assigns a node changed. */
  'capacity_changed',
  'zone_changed',
  /** Layout tags changed — this is also how a rename shows up. */
  'tags_changed',
  /** A data or metadata partition changed size: the drive-swap fingerprint. */
  'disk_changed',
  /** Stored bytes fell sharply on one node while its peers held steady. */
  'data_drop',
  /** `is_up` flipped between two samples. */
  'node_state',
  /** The node reported a different Garage version. */
  'version_changed',
  /** Written by an admin. */
  'note',
  /**
   * An admin launched a Garage repair operation (a scrub command, a block
   * repair, a rebalance) through /admin/repairs.
   *
   * **One kind, not one per operation.** `kind` says what sort of thing
   * happened; which repair it was is in `new_value`, raw, as everything else in
   * this collection is. Three kinds would buy three KIND_LABELS entries and
   * three filter options for one concept.
   */
  'repair',
] as const;

/**
 * Who wrote a row.
 *
 * **`action` is deliberately not `manual`.** "Under repair" is
 * `source = "manual" && ended_at = ""` (ClusterEventMutator.listOpenManual),
 * and launching a repair is instantaneous — nothing ever closes it. A repair
 * row written as `manual` would pin its node "under repair" for ever, amber on
 * every node card, until somebody hand-closed a row that was never open. A
 * third value keeps that query character-for-character correct and touches no
 * existing filter.
 *
 * `action` rather than `system` or `automated` because it is neither: a human
 * pressed a button, but the row records the action taken, not an observation
 * and not a note.
 */
export const CLUSTER_EVENT_SOURCES = ['detector', 'manual', 'action'] as const;

export const CLUSTER_EVENT_SEVERITIES = [
  'info',
  'warning',
  'critical',
] as const;

/**
 * Why a human logged something. Detector rows leave this unset — the `kind`
 * already says what was observed, and guessing a cause is the detector's job
 * least of all.
 */
export const CLUSTER_EVENT_CATEGORIES = [
  'hardware-failure',
  'disk-replaced',
  'maintenance',
  'upgrade',
  'incident',
  'decommission',
  'other',
] as const;

/**
 * One entry on the cluster timeline: either a change the scraper noticed, or a
 * note an admin wrote.
 *
 * **Why this collection has to exist at all.** Garage keeps no history of
 * itself. There is no event stream, no webhook, and no attribution anywhere in
 * the admin API; `GetClusterLayoutHistory` returns per-version node *counts*
 * with no timestamps and no role detail, so a past layout version cannot even
 * be diffed after the fact. The only server-side timestamps in the whole spec
 * are `created` on buckets, keys and admin tokens. So unlike GarageClusterCache
 * — which mirrors state Garage owns — nothing here is a copy of anything: a
 * change is only observable at the moment two consecutive samples disagree,
 * and if it is not written down then it does not exist anywhere.
 *
 * **One collection, three authors.** `source` separates them. The detector
 * writes through the JSVM inside the scrape transaction; a human writes a note
 * through POST /next-api/garage/events; an admin launching a repair writes
 * through POST /next-api/garage/repairs. Annotation is a set of fields on the
 * row rather than a second collection, so a detected fact and the explanation
 * for it can never drift apart or be reordered against each other.
 *
 * **All three write rules are null**, as on StorageClaimAudit: the cron
 * bypasses rules through the Go/JSVM layer, and the route handlers write as a
 * superuser. That makes the log genuinely append-only from a browser, which
 * the permissive rules on AccessKeys/Buckets are not — there, the
 * Route-Handler funnel is only a convention.
 *
 * Node identity is a plain TextField, never a relation: nodes are Garage
 * entities with no PB counterpart, and a `node_removed` row has to outlive the
 * node it describes. `node_hostname` / `node_zone` are snapshots for the same
 * reason — but note that they are *not* how a node is labelled in the UI, which
 * resolves names from the live layout (see webapp/src/lib/node-label.ts).
 *
 * `previous_value` / `new_value` hold the **raw** value as text — a byte count
 * as digits, a zone as its name — never a rendered string. The UI formats them
 * by `kind`, so a row stays re-renderable when the formatting changes.
 *
 * Nothing prunes this collection. It is a handful of rows a week, and the
 * whole point of a timeline is that it remembers further back than the metrics
 * it explains (NodeMetrics keeps 90 days by default).
 */
export const ClusterEventSchema = z
  .object({
    kind: SelectField(CLUSTER_EVENT_KINDS),
    source: SelectField(CLUSTER_EVENT_SOURCES),
    severity: SelectField(CLUSTER_EVENT_SEVERITIES).default('info'),
    /** "" for a cluster-wide event (a layout version bump, a manual note). */
    node_id: TextField({ max: 128 }).optional(),
    node_hostname: TextField({ max: 255 }).optional(),
    node_zone: TextField({ max: 64 }).optional(),
    /** One line, written by the detector too so a row reads on its own. */
    title: TextField().min(1).max(200),
    detail: TextField({ max: 2000 }).optional(),
    /** Raw, unformatted. See the docblock. */
    previous_value: TextField({ max: 255 }).optional(),
    new_value: TextField({ max: 255 }).optional(),
    /** Manual rows only. */
    category: SelectField(CLUSTER_EVENT_CATEGORIES).optional(),
    /**
     * When it happened. For a detected row this is the scrape time, which
     * bounds the truth to the preceding sample interval rather than pinning
     * it; for a manual row the admin picks it. Sorting is on this, not on
     * `created`, so a note about last Tuesday lands on last Tuesday.
     */
    occurred_at: DateField(),
    /**
     * Empty means still open. An open manual row pinned to a node is what puts
     * that node in the "under repair" state on /admin/events — one rule, no
     * extra column, and closing the row is what clears it.
     */
    ended_at: DateField().optional(),
    annotation: TextField({ max: 2000 }).optional(),
    annotated_by: TextField({ max: 255 }).optional(),
    annotated_at: DateField().optional(),
    /** Who wrote a manual row. Detector rows leave both empty. */
    actor_id: TextField({ max: 32 }).optional(),
    actor_email: TextField({ max: 255 }).optional(),
  })
  .extend(baseSchema);

export const ClusterEventInputSchema = z.object({
  kind: z.enum(CLUSTER_EVENT_KINDS),
  source: z.enum(CLUSTER_EVENT_SOURCES),
  severity: z.enum(CLUSTER_EVENT_SEVERITIES).default('info'),
  node_id: z.string().max(128).optional(),
  node_hostname: z.string().max(255).optional(),
  node_zone: z.string().max(64).optional(),
  title: z.string().min(1).max(200),
  detail: z.string().max(2000).optional(),
  previous_value: z.string().max(255).optional(),
  new_value: z.string().max(255).optional(),
  category: z.enum(CLUSTER_EVENT_CATEGORIES).optional(),
  occurred_at: z.string().min(1),
  ended_at: z.string().optional(),
  annotation: z.string().max(2000).optional(),
  annotated_by: z.string().max(255).optional(),
  annotated_at: z.string().optional(),
  actor_id: z.string().max(32).optional(),
  actor_email: z.string().max(255).optional(),
});

export const ClusterEventCollection = defineCollection({
  collectionName: 'ClusterEvents',
  schema: ClusterEventSchema,
  permissions: {
    // Admins read the timeline; nobody writes it over the API. The scrape cron
    // writes through the JSVM and the route handlers write as a superuser,
    // both of which bypass collection rules — so locking all three write rules
    // costs nothing and makes the log append-only from outside.
    listRule: '@collection.Admins.user ?= @request.auth.id',
    viewRule: '@collection.Admins.user ?= @request.auth.id',
    createRule: null,
    updateRule: null,
    deleteRule: null,
  },
  indexes: [
    'CREATE INDEX `idx_clusterevents_occurred` ON `ClusterEvents` (`occurred_at`)',
    'CREATE INDEX `idx_clusterevents_node_occurred` ON `ClusterEvents` (`node_id`, `occurred_at`)',
    'CREATE INDEX `idx_clusterevents_kind` ON `ClusterEvents` (`kind`)',
    // The "under repair" lookup: open manual rows. Filtering on source and
    // ended_at together is the one query the page runs on every load.
    'CREATE INDEX `idx_clusterevents_source_ended` ON `ClusterEvents` (`source`, `ended_at`)',
  ],
});

export default ClusterEventCollection;

export type ClusterEvent = z.infer<typeof ClusterEventSchema>;
export type ClusterEventInput = z.infer<typeof ClusterEventInputSchema>;
export type ClusterEventKind = (typeof CLUSTER_EVENT_KINDS)[number];
export type ClusterEventSource = (typeof CLUSTER_EVENT_SOURCES)[number];
export type ClusterEventSeverity = (typeof CLUSTER_EVENT_SEVERITIES)[number];
export type ClusterEventCategory = (typeof CLUSTER_EVENT_CATEGORIES)[number];
