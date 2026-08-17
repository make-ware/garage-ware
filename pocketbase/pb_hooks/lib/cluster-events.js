//
// Cluster events: turn two consecutive node-metrics scrapes into a timeline.
//
// Garage keeps no history of itself. There is no event stream, no webhook and
// no attribution in the admin API, and GetClusterLayoutHistory returns
// per-version node *counts* with no timestamps and no role detail — so a past
// layout change cannot be reconstructed after the fact. A change is only
// observable in the moment two consecutive samples disagree, which is exactly
// what this file looks for. See shared/src/schema/cluster-event.ts.
//
// `diffObservations` is a pure function (no Goja globals, no requires) so it
// can be unit tested from the webapp's vitest setup, the same arrangement as
// `bucketHistory` in node-metrics.js. `recordEvents` is the thin writer around
// it, called by scrapeOnce inside the scrape's own transaction so a sample and
// the events derived from it commit together.
//
// An "observation" is the subset of a NodeMetrics row this needs, as a plain
// object. scrapeOnce builds the current ones on its way to writing the rows and
// reads the previous ones back out of the collection, so the diff sees exactly
// what was stored and nothing else — no second state store, and no new Garage
// calls.
//
// Lives in a plain `.js` (not `*.pb.js`, which PocketBase would load as a hook
// file in its own right).
//
// **What is deliberately NOT here:** the median-comparison shortfall in
// webapp/src/lib/metrics/data-coverage.ts. That check is comparative and
// re-decides every scrape, so writing it would append the same finding every 15
// minutes until someone fixed the node. /admin/events surfaces it as a
// suggestion and a human turns it into a `note` — which is also the only way a
// timeline entry ever gets a cause attached to it.

const COLLECTION = "ClusterEvents";

/**
 * How far a total may move before it counts as a different disk. Filesystem
 * totals are stable between samples, so this only has to absorb rounding — a
 * real resize or swap moves it by orders of magnitude more.
 */
const DISK_CHANGE_TOLERANCE = 0.01;

/** Fraction of stored bytes a node must lose in one interval to be flagged. */
const DATA_DROP_PCT = 0.1;

/**
 * Below this, a node holds too little for a percentage to mean anything — a
 * dev cluster with one object in it would alarm on every deletion.
 */
const DATA_DROP_MIN_BYTES = 64 * 1024 * 1024 * 1024;

/**
 * A node's drop is suppressed when its **peers** dropped this much of the same
 * proportion. Deleting a bucket takes bytes off every node at once and is not
 * data loss; a drive being wiped takes them off exactly one.
 *
 * Peers, not the cluster including the node itself: with three nodes and one
 * wiped, the node's own loss is a third of the cluster figure and deflates the
 * comparison towards suppressing exactly the case this exists to catch. With
 * one node there are no peers, nothing contradicts the drop, and it is
 * reported — under-alarming is the worse failure here, and a single-node
 * cluster is a development setup.
 */
const CLUSTER_DROP_RATIO = 0.5;

/**
 * Byte formatting for titles and detail lines. Local rather than required from
 * lib/format.js so this module stays free of requires and loadable from vitest
 * — the same trade the repo already makes for the formatter inside the
 * bucket-usage-alerts cron. Decimal (SI) units, matching
 * webapp/src/lib/format.ts.
 */
function formatBytes(bytes) {
  if (!isFinite(bytes)) return String(bytes);
  const KB = 1e3,
    MB = 1e6,
    GB = 1e9,
    TB = 1e12,
    PB = 1e15;
  const abs = Math.abs(bytes);
  let value, unit;
  if (abs >= PB) {
    value = bytes / PB;
    unit = "PB";
  } else if (abs >= TB) {
    value = bytes / TB;
    unit = "TB";
  } else if (abs >= GB) {
    value = bytes / GB;
    unit = "GB";
  } else if (abs >= MB) {
    value = bytes / MB;
    unit = "MB";
  } else if (abs >= KB) {
    value = bytes / KB;
    unit = "KB";
  } else {
    return bytes + " B";
  }
  let s = value.toFixed(2);
  if (s.indexOf(".") !== -1) s = s.replace(/\.?0+$/, "");
  return s + " " + unit;
}

function pct(fraction) {
  return (100 * fraction).toFixed(1) + "%";
}

/**
 * A node's label for event copy: its key, verbatim.
 *
 * Rows carry node keys (see pb_hooks/lib/node-key.js), so there is nothing to
 * truncate here — this file used to keep its own 8-character shortener, whose
 * output was frozen into `title` and shipped to non-admins.
 *
 * Deliberately NOT the hostname, which this used to prefer. A node is
 * identified by its name or its key and by nothing else; names live in the
 * layout, which rows do not carry, and the UI resolves those at display time.
 */
function nodeLabel(nodeId) {
  return String(nodeId || "");
}

/** Used bytes on a partition, or null when there was no reading (total 0). */
function usedBytes(total, available) {
  if (!(total > 0)) return null;
  return Math.max(total - (available || 0), 0);
}

function byNode(rows) {
  const map = {};
  for (const row of rows || []) {
    if (row && row.node_id) map[row.node_id] = row;
  }
  return map;
}

/**
 * The layout version these rows were taken under, or null if none of them
 * carries a role reading. All rows in one scrape share it — it is denormalized
 * per row so a bump is detectable from any node's previous sample.
 */
function layoutVersionOf(rows) {
  for (const row of rows || []) {
    if (row && row.role_ok) return row.layout_version || 0;
  }
  return null;
}

/**
 * Stored bytes before and after, summed over the nodes that appear in **both**
 * scrapes with a reading in each. Restricting it to that intersection is what
 * stops a node joining or leaving from reading as the cluster gaining or
 * losing data, which would otherwise suppress or manufacture a data_drop on
 * some unrelated node.
 */
function pairedUsedTotals(prev, curRows) {
  let before = 0;
  let after = 0;
  for (const cur of curRows || []) {
    const p = prev[cur.node_id];
    if (!p) continue;
    const b = usedBytes(p.data_total_bytes, p.data_available_bytes);
    const a = usedBytes(cur.data_total_bytes, cur.data_available_bytes);
    if (b === null || a === null) continue;
    before += b;
    after += a;
  }
  return { before: before, after: after };
}

function event(fields) {
  return {
    kind: fields.kind,
    source: "detector",
    severity: fields.severity || "info",
    node_id: fields.node_id || "",
    node_hostname: fields.node_hostname || "",
    node_zone: fields.node_zone || "",
    title: fields.title,
    detail: fields.detail || "",
    // Raw values, never rendered — the UI formats them by `kind`, so a row
    // stays re-renderable when the formatting changes.
    previous_value: fields.previous_value === undefined ? "" : String(fields.previous_value),
    new_value: fields.new_value === undefined ? "" : String(fields.new_value),
  };
}

/**
 * Everything that changed between two scrapes.
 *
 * `prevRows` / `curRows` are arrays of observations (see the header). Returns
 * an array of event objects with no timestamp — the caller stamps
 * `occurred_at`, which keeps this pure and keeps every event in one scrape on
 * the same instant.
 *
 * The rules, and why each guard is there:
 *
 *   - A node with no previous observation produces nothing. That covers a new
 *     node's first sample and the first run after a gap in the cron, both of
 *     which are "we were not looking", not "nothing happened".
 *   - Layout-derived kinds additionally require `role_ok` on **both** rows.
 *     Rows written before those columns existed read false, so the first scrape
 *     after that migration cannot mistake an absent field (which PocketBase
 *     reads back as 0) for a capacity of zero and emit a spurious change for
 *     every storage node. See the migration 1786800000_updated_NodeMetrics.js.
 *   - Partition kinds require a non-zero total on both rows, because 0 means
 *     "no reading", not "no space".
 *   - Emission is edge-triggered only. A node flapping every scrape therefore
 *     costs at most two rows per interval, so no debounce is needed.
 */
function diffObservations(prevRows, curRows) {
  const events = [];
  const prev = byNode(prevRows);
  const seenNow = byNode(curRows);

  // ---- cluster-scoped ----------------------------------------------------
  const prevVersion = layoutVersionOf(prevRows);
  const curVersion = layoutVersionOf(curRows);
  if (prevVersion !== null && curVersion !== null && prevVersion !== curVersion) {
    events.push(
      event({
        kind: "layout_version",
        severity: "info",
        title: "Cluster layout moved to version " + curVersion,
        detail:
          "The layout was re-applied. Any node-level changes it made are recorded alongside this entry.",
        previous_value: prevVersion,
        new_value: curVersion,
      })
    );
  }

  // The sanity check behind data_drop: a bucket deletion takes bytes off every
  // node at once, and that is not data loss. Each node is measured against its
  // peers, so the totals here have the node under test subtracted out below.
  const paired = pairedUsedTotals(prev, curRows);

  // ---- per node still being reported -------------------------------------
  for (const cur of curRows || []) {
    const p = prev[cur.node_id];
    if (!p) continue; // no diff base — see the docblock

    const label = nodeLabel(cur.node_id);
    const base = {
      node_id: cur.node_id,
      node_hostname: cur.node_hostname,
      node_zone: cur.node_zone,
    };

    // -- connectivity. Sampled every 15 minutes, so the timestamp bounds the
    //    transition to the preceding interval rather than pinning it; the page
    //    says so, and this stays a state change rather than an outage record.
    if (!!p.is_up !== !!cur.is_up) {
      events.push(
        event(
          Object.assign({}, base, {
            kind: "node_state",
            severity: cur.is_up ? "info" : "warning",
            title: cur.is_up
              ? label + " is back online"
              : label + " is not responding",
            detail: cur.is_up
              ? "The node answered this scrape after being disconnected at the previous one."
              : "The node was disconnected at this scrape. Sampling is every 15 minutes, so it went down somewhere in the preceding interval.",
            previous_value: p.is_up ? "up" : "down",
            new_value: cur.is_up ? "up" : "down",
          })
        )
      );
    }

    // -- disk sizes. A total that moves is a partition that was resized or
    //    replaced, which is the closest thing to a hardware signal available.
    const axes = [
      { key: "data", label: "Data", total: "data_total_bytes" },
      { key: "meta", label: "Metadata", total: "meta_total_bytes" },
    ];
    for (const axis of axes) {
      const before = p[axis.total];
      const after = cur[axis.total];
      if (!(before > 0) || !(after > 0)) continue; // 0 = no reading
      if (Math.abs(after - before) / before <= DISK_CHANGE_TOLERANCE) continue;
      const grew = after > before;
      events.push(
        event(
          Object.assign({}, base, {
            kind: "disk_changed",
            severity: grew ? "info" : "warning",
            title:
              axis.label +
              " partition on " +
              label +
              (grew ? " grew to " : " shrank to ") +
              formatBytes(after),
            detail:
              formatBytes(before) +
              " → " +
              formatBytes(after) +
              ". A partition total only moves when the filesystem behind it does — a resize, or a replaced drive.",
            previous_value: before,
            new_value: after,
          })
        )
      );
    }

    // -- stored bytes falling away on one node while its peers hold steady.
    //    This is the drive-wipe fingerprint, and unlike the coverage check it
    //    is edge-triggered, so it is recorded rather than suggested.
    const beforeUsed = usedBytes(p.data_total_bytes, p.data_available_bytes);
    const afterUsed = usedBytes(cur.data_total_bytes, cur.data_available_bytes);
    if (
      beforeUsed !== null &&
      afterUsed !== null &&
      beforeUsed >= DATA_DROP_MIN_BYTES
    ) {
      const dropPct = (beforeUsed - afterUsed) / beforeUsed;
      // Everything except this node. No peers with a reading leaves this at 0,
      // so nothing contradicts the drop and it is reported.
      const peerBefore = paired.before - beforeUsed;
      const peerAfter = paired.after - afterUsed;
      const peerDropPct =
        peerBefore > 0 ? Math.max((peerBefore - peerAfter) / peerBefore, 0) : 0;
      if (dropPct >= DATA_DROP_PCT && peerDropPct < dropPct * CLUSTER_DROP_RATIO) {
        events.push(
          event(
            Object.assign({}, base, {
              kind: "data_drop",
              severity: "critical",
              title:
                label +
                " lost " +
                formatBytes(beforeUsed - afterUsed) +
                " of stored data",
              detail:
                formatBytes(beforeUsed) +
                " → " +
                formatBytes(afterUsed) +
                " (" +
                pct(dropPct) +
                "). Its peers moved " +
                pct(peerDropPct) +
                " over the same interval, so this is not a deletion they shared in.",
              previous_value: beforeUsed,
              new_value: afterUsed,
            })
          )
        );
      }
    }

    // -- daemon version. Comes from GetClusterStatus, so it is not gated; ""
    //    means the node did not report one and is never treated as a change.
    if (p.garage_version && cur.garage_version && p.garage_version !== cur.garage_version) {
      events.push(
        event(
          Object.assign({}, base, {
            kind: "version_changed",
            severity: "info",
            title: label + " is now running Garage " + cur.garage_version,
            detail: p.garage_version + " → " + cur.garage_version + ".",
            previous_value: p.garage_version,
            new_value: cur.garage_version,
          })
        )
      );
    }

    // -- zone. Also from GetClusterStatus (the node's assigned role), so it is
    //    ungated — but "" means "no role", and a role appearing or disappearing
    //    is node_added / node_removed's business, not a zone change.
    if (p.node_zone && cur.node_zone && p.node_zone !== cur.node_zone) {
      events.push(
        event(
          Object.assign({}, base, {
            kind: "zone_changed",
            severity: "info",
            title: label + " moved to zone " + cur.node_zone,
            detail: p.node_zone + " → " + cur.node_zone + ".",
            previous_value: p.node_zone,
            new_value: cur.node_zone,
          })
        )
      );
    }

    // -- layout role. Everything below needs the gate on both rows.
    if (!p.role_ok || !cur.role_ok) continue;

    const beforeCap = p.role_capacity_bytes || 0;
    const afterCap = cur.role_capacity_bytes || 0;
    if (beforeCap !== afterCap) {
      if (beforeCap === 0) {
        events.push(
          event(
            Object.assign({}, base, {
              kind: "node_added",
              severity: "info",
              title:
                label + " joined the layout with " + formatBytes(afterCap),
              detail:
                "The node previously held no storage role" +
                (cur.node_zone ? " and is now in zone " + cur.node_zone : "") +
                ".",
              previous_value: 0,
              new_value: afterCap,
            })
          )
        );
      } else if (afterCap === 0) {
        events.push(
          event(
            Object.assign({}, base, {
              kind: "node_removed",
              severity: "warning",
              title: label + " lost its storage role",
              detail:
                "It was assigned " +
                formatBytes(beforeCap) +
                " and now holds no role. It will drain if it is still connected.",
              previous_value: beforeCap,
              new_value: 0,
            })
          )
        );
      } else {
        const grew = afterCap > beforeCap;
        events.push(
          event(
            Object.assign({}, base, {
              kind: "capacity_changed",
              severity: grew ? "info" : "warning",
              title:
                "Assigned capacity for " +
                label +
                (grew ? " raised to " : " lowered to ") +
                formatBytes(afterCap),
              detail:
                formatBytes(beforeCap) +
                " → " +
                formatBytes(afterCap) +
                ". This is what the operator assigned, not what the disk holds.",
              previous_value: beforeCap,
              new_value: afterCap,
            })
          )
        );
      }
    }

    const beforeTags = p.node_tags || "";
    const afterTags = cur.node_tags || "";
    if (beforeTags !== afterTags) {
      events.push(
        event(
          Object.assign({}, base, {
            kind: "tags_changed",
            severity: "info",
            // A `name:` tag is how a node gets a name (see
            // webapp/src/lib/node-label.ts), so a rename arrives here.
            title: "Layout tags changed on " + label,
            detail:
              (beforeTags || "(none)") + " → " + (afterTags || "(none)") + ".",
            previous_value: beforeTags,
            new_value: afterTags,
          })
        )
      );
    }
  }

  // ---- nodes that stopped being reported ---------------------------------
  // A node losing its role is caught above; this is a node Garage no longer
  // lists at all, which produces no row and so cannot be caught there.
  for (const p of prevRows || []) {
    if (seenNow[p.node_id]) continue;
    events.push(
      event({
        kind: "node_removed",
        severity: "warning",
        node_id: p.node_id,
        node_hostname: p.node_hostname,
        node_zone: p.node_zone,
        title:
          nodeLabel(p.node_id) + " is no longer part of the cluster",
        detail:
          "Garage stopped listing this node entirely. It was last seen " +
          (p.is_up ? "connected" : "disconnected") +
          ".",
        previous_value: p.role_capacity_bytes || 0,
        new_value: 0,
      })
    );
  }

  return events;
}

/**
 * Persist detector events. `occurredAt` is a PocketBase date string supplied by
 * the caller so every event from one scrape shares an instant — and so this
 * file needs no clock, which is what keeps `diffObservations` testable.
 *
 * `app` must be the transactional app from the scrape: an event and the sample
 * it was derived from commit together or not at all.
 */
function recordEvents(app, events, occurredAt) {
  if (!events || events.length === 0) return 0;
  const collection = app.findCollectionByNameOrId(COLLECTION);
  let written = 0;
  for (const e of events) {
    const record = new Record(collection);
    record.set("kind", e.kind);
    record.set("source", e.source);
    record.set("severity", e.severity);
    record.set("node_id", e.node_id);
    record.set("node_hostname", e.node_hostname);
    record.set("node_zone", e.node_zone);
    record.set("title", e.title);
    record.set("detail", e.detail);
    record.set("previous_value", e.previous_value);
    record.set("new_value", e.new_value);
    record.set("occurred_at", occurredAt);
    app.save(record);
    written++;
  }
  return written;
}

module.exports = {
  DISK_CHANGE_TOLERANCE,
  DATA_DROP_PCT,
  DATA_DROP_MIN_BYTES,
  CLUSTER_DROP_RATIO,
  diffObservations,
  recordEvents,
};
