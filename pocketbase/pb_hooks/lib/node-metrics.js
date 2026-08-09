//
// Per-node metrics: scrape, history bucketing, retention.
//
// `scrapeOnce` records one NodeMetrics row per cluster node from two calls to
// the central Garage admin API (GetClusterStatus for connectivity + partition
// space, GetNodeStatistics?node=* for resync counters). It is shared by the
// `node-metrics-scrape` cron, and the superuser route POST /api/node-metrics/scrape
// — one implementation on purpose, like storage-balance.js.
//
// `historyFor` backs GET /api/node-metrics/history: it reads a time range
// in-process (a 30-day window is ~23k rows — cheap here, prohibitive as paged
// HTTP reads from the webapp) and collapses it into per-(node, bucket) points
// via `bucketHistory`.
//
// `bucketHistory` is a pure function (no Goja globals) so it can be unit
// tested from the webapp's vitest setup.
//
// Lives in a plain `.js` (not `*.pb.js`, which PocketBase would load as a hook
// file in its own right) and is `require`d INSIDE each handler: Goja runs
// every callback in a fresh executor and will not carry top-level declarations
// from main.pb.js into them.
//
// Null conventions (see shared/src/schema/node-metric.ts): PB number fields
// cannot hold null, so stored rows use `node_stats_ok` to gate the resync
// fields and `*_total_bytes === 0` to mean "no partition data". Real nulls
// only appear in the JSON `historyFor` emits.

const COLLECTION = "NodeMetrics";

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
 *              data_total_bytes|null, data_available_bytes|null,
 *              meta_total_bytes|null, meta_available_bytes|null }]
 *           sorted by t; t is the bucket-start epoch in ms.
 *
 * Per bucket: uptime_pct counts every sample; resync fields average only
 * samples with node_stats_ok (else null — a gap, not a zero); partition
 * fields average only samples whose total > 0 (else null).
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
      node.label = {
        node_id: nodeId,
        node_hostname: row.node_hostname || "",
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
 * Returns { skipped? , recorded, statsFailed, pruned, errors }. `skipped` is
 * set (with a warn log) when GARAGE_ADMIN_URL/TOKEN are absent — the env is
 * optional in dev, so this is a degraded state, not a crash. A failed
 * GetClusterStatus aborts the run (no node identity, nothing to record); a
 * failed GetNodeStatistics only clears node_stats_ok on every row.
 */
function scrapeOnce(app, opts) {
  const baseUrl = $os.getenv("GARAGE_ADMIN_URL").replace(/\/+$/, "");
  const token = $os.getenv("GARAGE_ADMIN_TOKEN");
  if (!baseUrl || !token) {
    console.warn(
      "[node-metrics] GARAGE_ADMIN_URL/GARAGE_ADMIN_TOKEN not set; skipping run"
    );
    return { skipped: true, recorded: 0, statsFailed: 0, pruned: 0, errors: 0 };
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

  let recorded = 0;
  let statsFailed = 0;
  let errors = 0;
  let pruned = 0;

  app.runInTransaction((txApp) => {
    const collection = txApp.findCollectionByNameOrId(COLLECTION);

    for (const node of status.nodes || []) {
      try {
        const stats = statsSuccess[node.id];
        const bm = stats && stats.blockManagerStats;
        const data = node.dataPartition;
        const meta = node.metadataPartition;

        const record = new Record(collection);
        record.set("node_id", node.id);
        record.set("node_hostname", node.hostname || "");
        record.set("node_zone", (node.role && node.role.zone) || "");
        record.set("is_up", !!node.isUp);
        record.set("node_stats_ok", !!bm);
        record.set("resync_queue_length", bm ? bm.resyncQueueLen : 0);
        record.set("resync_errored_blocks", bm ? bm.resyncErrors : 0);
        record.set("data_total_bytes", data ? data.total : 0);
        record.set("data_available_bytes", data ? data.available : 0);
        record.set("meta_total_bytes", meta ? meta.total : 0);
        record.set("meta_available_bytes", meta ? meta.available : 0);
        txApp.save(record);

        recorded++;
        if (!bm) statsFailed++;
      } catch (err) {
        errors++;
        console.error("[node-metrics] failed to record node:", node.id, err);
      }
    }

    if (opts && opts.prune) {
      pruned = pruneOld(txApp);
    }
  });

  return {
    recorded: recorded,
    statsFailed: statsFailed,
    pruned: pruned,
    errors: errors,
  };
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
