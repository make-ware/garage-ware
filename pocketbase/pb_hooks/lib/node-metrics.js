//
// Per-node metrics: scrape, history bucketing, retention.
//
// `scrapeOnce` records one NodeMetrics row per cluster node from three calls to
// the central Garage admin API: GetClusterStatus for connectivity + partition
// space, GetNodeStatistics?node=* for resync counters and the block refcount
// entry count, and GetClusterLayout for the partitions the layout assigns each
// node plus the cluster's partition size. That last call is what buys the
// denominator: a stored partition holds one full replica of that partition's
// data, so `usedBytes / storedPartitions` is comparable across nodes of wildly
// different sizes — see webapp/src/lib/metrics/data-coverage.ts. It is shared
// by the `node-metrics-scrape` cron, and the superuser route
// POST /api/node-metrics/scrape — one implementation on purpose, like
// storage-balance.js.
//
// `historyFor` backs GET /api/node-metrics/history: it reads a time range
// in-process (a 30-day window is ~23k rows — cheap here, prohibitive as paged
// HTTP reads from the webapp) and collapses it into per-(node, bucket) points
// via `bucketHistory`.
//
// `bucketHistory` is a pure function (no Goja globals) so it can be unit
// tested from the webapp's vitest setup.
//
// The same run also feeds the cluster timeline. Before writing this scrape's
// rows, `scrapeOnce` reads the previous ones back (PREV_WINDOW_SEC) and hands
// both sets to `diffObservations` in lib/cluster-events.js; anything that
// changed is written as a ClusterEvents row inside the same transaction. The
// read has to come first — after the writes, "previous" would be the row we
// just saved. No new Garage calls and no extra state store: the previous
// observation IS the previous NodeMetrics row, which is what the `role_*`,
// `layout_version` and `garage_version` columns are there for.
//
// The same block also RESOLVES timeline rows. An outage is one row that is
// opened and later closed, not a row per edge, so this scrape both appends what
// started and closes what has stopped — `reconcileOngoing` reads the open rows
// back through `readOpenConditions` in the same transaction. That half needs no
// previous sample, only the current state, which is why it runs even when the
// diff cannot.
//
// Lives in a plain `.js` (not `*.pb.js`, which PocketBase would load as a hook
// file in its own right) and is `require`d INSIDE each handler: Goja runs
// every callback in a fresh executor and will not carry top-level declarations
// from main.pb.js into them.
//
// Null conventions (see shared/src/schema/node-metric.ts): PB number fields
// cannot hold null, so stored rows use `node_stats_ok` to gate the resync
// fields and `rc_entries`, `layout_ok` to gate `stored_partitions` /
// `partition_size_bytes`, `role_ok` to gate `role_capacity_bytes` /
// `node_tags` / `layout_version`, and `*_total_bytes === 0` to mean "no
// partition data". Under `layout_ok`, `stored_partitions === 0` is a real
// reading ("this node holds no partitions") — which is why that gate has to
// exist at all, or a failed layout call would record every node as a gateway.
// `role_ok` carries a second job on top of that one: it also means "this row
// was written by a scraper that records the role columns", so a pre-migration
// row cannot be diffed against and the detector stays quiet on its first run.
// Real nulls only appear in the JSON `historyFor` emits.

const COLLECTION = "NodeMetrics";

/**
 * How far back scrapeOnce looks for the previous observation to diff against.
 * Wide enough to ride out a missed cron tick or two; narrow enough that a node
 * absent that long is a genuinely new observation rather than a diff base. A
 * longer outage produces no events for the gap, which is the honest answer —
 * we were not looking.
 */
const PREV_WINDOW_SEC = 2 * 3600;

/** Ranges the history endpoint serves: window size and bucket width. */
const RANGES = {
  "6h": { seconds: 6 * 3600, bucketSec: 900 },
  "24h": { seconds: 24 * 3600, bucketSec: 900 },
  "7d": { seconds: 7 * 86400, bucketSec: 3600 },
  "30d": { seconds: 30 * 86400, bucketSec: 10800 },
};

/**
 * PB autodate strings are "YYYY-MM-DD HH:mm:ss.sssZ" — the space separator is
 * not portably parseable, so restore the "T" first (same fix as formatPbDate
 * in webapp/src/lib/format.ts).
 */
function parsePbDateMs(value) {
  if (!value) return NaN;
  return Date.parse(String(value).replace(" ", "T"));
}

/** PB-format UTC timestamp for filter params and comparisons. */
function toPbDate(ms) {
  return new Date(ms).toISOString().replace("T", " ");
}

function mean(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Collapse raw sample rows into one point per (node, bucket).
 *
 * `rows` are plain objects with the NodeMetrics fields plus `created`
 * (PB date string). Returns:
 *   nodes:  [{ node_id, node_hostname, node_zone }] — latest label per node,
 *           sorted by node_id so callers get a stable order (stable colors).
 *   points: [{ t, node_id, samples, uptime_pct,
 *              resync_queue_length|null, resync_errored_blocks|null,
 *              rc_entries|null, stored_partitions|null,
 *              partition_size_bytes|null,
 *              data_total_bytes|null, data_available_bytes|null,
 *              meta_total_bytes|null, meta_available_bytes|null }]
 *           sorted by t; t is the bucket-start epoch in ms.
 *
 * Per bucket: uptime_pct counts every sample; the resync fields and rc_entries
 * average only samples with node_stats_ok (else null — a gap, not a zero); the
 * two layout fields average only samples with layout_ok, a gate independent of
 * the partition one (a down node still holds a layout role but reports no
 * space, and a gateway is the reverse); partition fields average only samples
 * whose total > 0 (else null).
 *
 * Two wrinkles in averaging the layout fields:
 *   - stored_partitions can come out fractional when a layout change lands
 *     mid-bucket. That is correct — the node genuinely held N partitions and
 *     then M.
 *   - a gateway emits stored_partitions 0, not null. Under layout_ok, 0 is a
 *     reading ("holds no partitions"), and keeping that apart from "we never
 *     asked" is the whole justification for the layout_ok gate.
 */
function bucketHistory(rows, bucketSec) {
  const bucketMs = bucketSec * 1000;
  const byNode = {}; // node_id -> { label, labelMs, buckets: { t -> agg } }

  for (const row of rows) {
    const ms = parsePbDateMs(row.created);
    if (isNaN(ms)) continue;
    const nodeId = row.node_id;
    if (!nodeId) continue;

    let node = byNode[nodeId];
    if (!node) {
      node = { label: null, labelMs: -Infinity, buckets: {} };
      byNode[nodeId] = node;
    }
    if (ms > node.labelMs) {
      node.labelMs = ms;
      // No node_hostname. A node is identified by its name or its key and by
      // nothing else, and this payload reaches any signed-in user; the column
      // stays on the row for the event differ, but nothing charts it.
      node.label = {
        node_id: nodeId,
        node_zone: row.node_zone || "",
      };
    }

    const t = Math.floor(ms / bucketMs) * bucketMs;
    let agg = node.buckets[t];
    if (!agg) {
      agg = {
        samples: 0,
        up: 0,
        resyncQueue: [],
        resyncErrored: [],
        rcEntries: [],
        storedPartitions: [],
        partitionSize: [],
        dataTotal: [],
        dataAvail: [],
        metaTotal: [],
        metaAvail: [],
      };
      node.buckets[t] = agg;
    }

    agg.samples++;
    if (row.is_up) agg.up++;
    if (row.node_stats_ok) {
      agg.resyncQueue.push(row.resync_queue_length || 0);
      agg.resyncErrored.push(row.resync_errored_blocks || 0);
      agg.rcEntries.push(row.rc_entries || 0);
    }
    // Its own gate, deliberately not folded into the partition one below: a
    // down node still holds a layout role but reports no partition space, and
    // a gateway reports space but holds no partitions.
    if (row.layout_ok) {
      agg.storedPartitions.push(row.stored_partitions || 0);
      agg.partitionSize.push(row.partition_size_bytes || 0);
    }
    if (row.data_total_bytes > 0) {
      agg.dataTotal.push(row.data_total_bytes);
      agg.dataAvail.push(row.data_available_bytes || 0);
    }
    if (row.meta_total_bytes > 0) {
      agg.metaTotal.push(row.meta_total_bytes);
      agg.metaAvail.push(row.meta_available_bytes || 0);
    }
  }

  const nodeIds = Object.keys(byNode).sort();
  const nodes = [];
  const points = [];
  for (const nodeId of nodeIds) {
    nodes.push(byNode[nodeId].label);
    const buckets = byNode[nodeId].buckets;
    for (const key of Object.keys(buckets)) {
      const agg = buckets[key];
      points.push({
        t: Number(key),
        node_id: nodeId,
        samples: agg.samples,
        uptime_pct: (100 * agg.up) / agg.samples,
        resync_queue_length: mean(agg.resyncQueue),
        resync_errored_blocks: mean(agg.resyncErrored),
        rc_entries: mean(agg.rcEntries),
        stored_partitions: mean(agg.storedPartitions),
        partition_size_bytes: mean(agg.partitionSize),
        data_total_bytes: mean(agg.dataTotal),
        data_available_bytes: mean(agg.dataAvail),
        meta_total_bytes: mean(agg.metaTotal),
        meta_available_bytes: mean(agg.metaAvail),
      });
    }
  }
  points.sort((a, b) => a.t - b.t || (a.node_id < b.node_id ? -1 : 1));

  return { nodes: nodes, points: points };
}

/** GET the Garage admin API; returns parsed JSON or throws with context. */
function adminGet(baseUrl, token, path) {
  const res = $http.send({
    url: baseUrl + path,
    method: "GET",
    headers: { Authorization: "Bearer " + token },
    timeout: 10, // seconds, not ms
  });
  if (res.statusCode !== 200) {
    throw new Error("Garage admin API " + path + " returned " + res.statusCode);
  }
  return res.json;
}

/**
 * Record one sample row per cluster node; optionally prune old rows.
 *
 * Returns { skipped?, recorded, statsFailed, layoutFailed, pruned, events,
 * errors }. `skipped` is set (with a warn log) when GARAGE_ADMIN_URL/TOKEN are
 * absent — the env is optional in dev, so this is a degraded state, not a
 * crash. A failed GetClusterStatus aborts the run (no node identity, nothing
 * to record); a failed GetNodeStatistics only clears node_stats_ok on every
 * row, and a failed GetClusterLayout clears both layout_ok and role_ok.
 * `layoutFailed` and `events` are additive — existing callers destructure
 * { recorded, statsFailed } and are unaffected.
 *
 * The same transaction also writes the cluster timeline. Detection is
 * best-effort and never fails the scrape: a sample recorded without its events
 * is a small loss, a scrape lost because the differ threw is a hole in the
 * history the charts draw from.
 */
function scrapeOnce(app, opts) {
  // Required here rather than at module scope for two reasons: Goja runs every
  // callback in a fresh executor, and `__hooks` does not exist under vitest,
  // which imports this file to drive bucketHistory. Same arrangement as the
  // cluster-events require further down.
  const { nodeKey } = require(`${__hooks}/lib/node-key.js`);

  const baseUrl = $os.getenv("GARAGE_ADMIN_URL").replace(/\/+$/, "");
  const token = $os.getenv("GARAGE_ADMIN_TOKEN");
  if (!baseUrl || !token) {
    console.warn(
      "[node-metrics] GARAGE_ADMIN_URL/GARAGE_ADMIN_TOKEN not set; skipping run"
    );
    return {
      skipped: true,
      recorded: 0,
      statsFailed: 0,
      layoutFailed: 0,
      pruned: 0,
      events: 0,
      errors: 0,
    };
  }

  const status = adminGet(baseUrl, token, "/v2/GetClusterStatus");

  let statsSuccess = {};
  try {
    const stats = adminGet(baseUrl, token, "/v2/GetNodeStatistics?node=*");
    statsSuccess = (stats && stats.success) || {};
  } catch (err) {
    console.warn(
      "[node-metrics] GetNodeStatistics failed; recording rows without resync stats:",
      err
    );
  }

  // Non-fatal in the same shape as the stats call above: without it the rows
  // still carry uptime and space, they just cannot say how much of the ring
  // each node was assigned. `layoutOk` is what keeps that absence honest —
  // see the null conventions at the top of this file.
  let rolesById = {};
  let partitionSize = 0;
  let layoutVersion = 0;
  let layoutOk = false;
  try {
    const layout = adminGet(baseUrl, token, "/v2/GetClusterLayout");
    for (const role of (layout && layout.roles) || []) {
      if (role && role.id) rolesById[role.id] = role;
    }
    partitionSize = (layout && layout.partitionSize) || 0;
    layoutVersion = (layout && layout.version) || 0;
    layoutOk = true;
  } catch (err) {
    console.warn(
      "[node-metrics] GetClusterLayout failed; recording rows without partition assignment:",
      err
    );
  }

  let recorded = 0;
  let statsFailed = 0;
  let layoutFailed = 0;
  let errors = 0;
  let pruned = 0;
  let events = { created: 0, reopened: 0, closed: 0 };

  app.runInTransaction((txApp) => {
    const collection = txApp.findCollectionByNameOrId(COLLECTION);

    // Before any write: what the previous scrape saw. Reading after the loop
    // would return the rows we are about to save.
    let previous = [];
    try {
      previous = readPreviousObservations(txApp);
    } catch (err) {
      console.warn("[node-metrics] previous-sample read failed; no events this run:", err);
    }
    const current = [];
    // Nodes whose row threw below. They are missing from `current` for a local
    // reason, and the timeline must not read that as the cluster losing them —
    // which would now cost an *open* condition rather than one stray row.
    const failedNodeIds = [];

    for (const node of status.nodes || []) {
      try {
        const stats = statsSuccess[node.id];
        const bm = stats && stats.blockManagerStats;
        const role = rolesById[node.id];
        const data = node.dataPartition;
        const meta = node.metadataPartition;

        // Built once and used twice — written to the row, then diffed — so the
        // timeline can never describe a sample different from the stored one.
        //
        // NOTE the three joins above (statsSuccess, rolesById, node itself) run
        // on the FULL id, because that is what all three Garage responses are
        // keyed by. Only the observation carries the key: nothing this hook
        // writes may hold a full node id. See pb_hooks/lib/node-key.js.
        const observation = {
          node_id: nodeKey(node.id),
          node_hostname: node.hostname || "",
          node_zone: (node.role && node.role.zone) || "",
          is_up: !!node.isUp,
          layout_ok: layoutOk,
          role_ok: layoutOk,
          // `capacity` is absent for a gateway and the role is absent entirely
          // for a node with none. Both fold to the 0 that role_ok makes
          // readable as "holds no storage role".
          role_capacity_bytes: (role && role.capacity) || 0,
          node_tags: role && role.tags ? role.tags.join(",") : "",
          layout_version: layoutVersion,
          garage_version: node.garageVersion || "",
          data_total_bytes: data ? data.total : 0,
          data_available_bytes: data ? data.available : 0,
          meta_total_bytes: meta ? meta.total : 0,
          meta_available_bytes: meta ? meta.available : 0,
        };

        const record = new Record(collection);
        record.set("node_id", observation.node_id);
        record.set("node_hostname", observation.node_hostname);
        record.set("node_zone", observation.node_zone);
        record.set("is_up", observation.is_up);
        record.set("node_stats_ok", !!bm);
        record.set("resync_queue_length", bm ? bm.resyncQueueLen : 0);
        record.set("resync_errored_blocks", bm ? bm.resyncErrors : 0);
        record.set("rc_entries", bm ? bm.rcEntries || 0 : 0);
        record.set("layout_ok", layoutOk);
        // `storedPartitions` is integer|null in the spec (null for a gateway),
        // and the role is absent entirely for a node with no role at all. The
        // `|| 0` folds both into the 0 that layout_ok makes readable as "holds
        // no partitions".
        record.set("stored_partitions", (role && role.storedPartitions) || 0);
        record.set("partition_size_bytes", partitionSize);
        record.set("role_ok", observation.role_ok);
        record.set("role_capacity_bytes", observation.role_capacity_bytes);
        record.set("node_tags", observation.node_tags);
        record.set("layout_version", observation.layout_version);
        record.set("garage_version", observation.garage_version);
        record.set("data_total_bytes", observation.data_total_bytes);
        record.set("data_available_bytes", observation.data_available_bytes);
        record.set("meta_total_bytes", observation.meta_total_bytes);
        record.set("meta_available_bytes", observation.meta_available_bytes);
        txApp.save(record);

        current.push(observation);
        recorded++;
        if (!bm) statsFailed++;
        if (!layoutOk) layoutFailed++;
      } catch (err) {
        errors++;
        failedNodeIds.push(nodeKey(node.id));
        console.error("[node-metrics] failed to record node:", node.id, err);
      }
    }

    // Best-effort, and deliberately so: the samples are the thing the charts
    // need, and losing a whole scrape because the differ threw would be the
    // worse trade. A node that failed to record above is absent from `current`,
    // so it is passed as `failedNodeIds` and excluded rather than being
    // reported as removed.
    //
    // **The guard is on the diff, not on the reconciliation.** Opening a
    // condition needs two samples that disagree, so it needs `previous`.
    // Closing one needs only the current state and a row already open — and a
    // node that recovered during a gap in the cron is precisely the case with
    // no `previous` to compare against and an outage still marked running.
    // Gating both on `previous.length` would leave that outage open for ever.
    if (current.length > 0) {
      try {
        const {
          diffObservations,
          reconcileOngoing,
          readOpenConditions,
          recordEvents,
          FLAP_WINDOW_SEC,
        } = require(`${__hooks}/lib/cluster-events.js`);

        const detected =
          previous.length > 0
            ? diffObservations(previous, current, failedNodeIds)
            : [];
        const openRows = readOpenConditions(
          txApp,
          toPbDate(Date.now() - FLAP_WINDOW_SEC * 1000)
        );
        events = recordEvents(
          txApp,
          reconcileOngoing(detected, current, openRows, failedNodeIds),
          toPbDate(Date.now())
        );
      } catch (err) {
        console.error("[cluster-events] detection failed:", err);
      }
    }

    if (opts && opts.prune) {
      pruned = pruneOld(txApp);
    }
  });

  return {
    recorded: recorded,
    statsFailed: statsFailed,
    layoutFailed: layoutFailed,
    pruned: pruned,
    events: events,
    errors: errors,
  };
}

/**
 * The newest observation per node within PREV_WINDOW_SEC — the diff base for
 * the cluster timeline. One query rather than a point-read per node, because
 * it also has to answer "which nodes were being reported last time" so a node
 * that vanished from the cluster (and therefore writes no row at all) can be
 * detected.
 *
 * Sorted newest-first, so the first row seen for a node is the one kept.
 */
function readPreviousObservations(app) {
  const cutoff = toPbDate(Date.now() - PREV_WINDOW_SEC * 1000);
  const records = app.findRecordsByFilter(
    COLLECTION,
    "created >= {:cutoff}",
    "-created",
    0,
    0,
    { cutoff: cutoff }
  );

  const seen = {};
  const out = [];
  for (const r of records) {
    const nodeId = r.getString("node_id");
    if (!nodeId || seen[nodeId]) continue;
    seen[nodeId] = true;
    out.push({
      node_id: nodeId,
      node_hostname: r.getString("node_hostname"),
      node_zone: r.getString("node_zone"),
      is_up: r.getBool("is_up"),
      layout_ok: r.getBool("layout_ok"),
      role_ok: r.getBool("role_ok"),
      role_capacity_bytes: r.getFloat("role_capacity_bytes"),
      node_tags: r.getString("node_tags"),
      layout_version: r.getFloat("layout_version"),
      garage_version: r.getString("garage_version"),
      data_total_bytes: r.getFloat("data_total_bytes"),
      data_available_bytes: r.getFloat("data_available_bytes"),
      meta_total_bytes: r.getFloat("meta_total_bytes"),
      meta_available_bytes: r.getFloat("meta_available_bytes"),
    });
  }
  return out;
}

/**
 * Delete rows older than NODE_METRICS_RETENTION_DAYS (default 90; 0 = keep
 * forever). Steady state removes ~one scrape's worth per run; the first run
 * after lowering the retention may delete a large backlog, hence the batches.
 */
function pruneOld(app) {
  const raw = $os.getenv("NODE_METRICS_RETENTION_DAYS");
  let days = raw === "" ? 90 : parseInt(raw, 10);
  if (isNaN(days) || days < 0) days = 90;
  if (days === 0) return 0;

  const cutoff = toPbDate(Date.now() - days * 86400000);
  let pruned = 0;
  for (;;) {
    const stale = app.findRecordsByFilter(
      COLLECTION,
      "created < {:cutoff}",
      "",
      500,
      0,
      { cutoff: cutoff }
    );
    if (stale.length === 0) break;
    for (const row of stale) app.delete(row);
    pruned += stale.length;
  }
  return pruned;
}

/**
 * The bucketed history for one named range — the payload for
 * GET /api/node-metrics/history. Throws on an unknown range key (the caller
 * turns that into a 400).
 */
function historyFor(app, rangeKey) {
  const range = RANGES[rangeKey];
  if (!range) {
    throw new Error("unknown range: " + rangeKey);
  }

  const cutoff = toPbDate(Date.now() - range.seconds * 1000);
  const records = app.findRecordsByFilter(
    COLLECTION,
    "created >= {:cutoff}",
    "created",
    0,
    0,
    { cutoff: cutoff }
  );

  const rows = [];
  for (const r of records) {
    rows.push({
      node_id: r.getString("node_id"),
      node_hostname: r.getString("node_hostname"),
      node_zone: r.getString("node_zone"),
      is_up: r.getBool("is_up"),
      node_stats_ok: r.getBool("node_stats_ok"),
      resync_queue_length: r.getFloat("resync_queue_length"),
      resync_errored_blocks: r.getFloat("resync_errored_blocks"),
      rc_entries: r.getFloat("rc_entries"),
      layout_ok: r.getBool("layout_ok"),
      stored_partitions: r.getFloat("stored_partitions"),
      partition_size_bytes: r.getFloat("partition_size_bytes"),
      data_total_bytes: r.getFloat("data_total_bytes"),
      data_available_bytes: r.getFloat("data_available_bytes"),
      meta_total_bytes: r.getFloat("meta_total_bytes"),
      meta_available_bytes: r.getFloat("meta_available_bytes"),
      created: r.getString("created"),
    });
  }

  const result = bucketHistory(rows, range.bucketSec);
  return {
    range: rangeKey,
    bucketSeconds: range.bucketSec,
    nodes: result.nodes,
    points: result.points,
  };
}

module.exports = { RANGES, bucketHistory, scrapeOnce, historyFor };
