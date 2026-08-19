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
// `diffObservations` and `reconcileOngoing` are pure functions (no Goja
// globals, no requires, not even a clock) so they can be unit tested from the
// webapp's vitest setup, the same arrangement as `bucketHistory` in
// node-metrics.js. `readOpenConditions` and `recordEvents` are the thin reader
// and writer around them, called by scrapeOnce inside the scrape's own
// transaction so a sample and the rows derived from it commit together.
//
// **Not every row is an instant.** The two ONGOING_KINDS describe a condition
// that starts and later stops, and get one row that is opened, possibly
// re-opened, and finally closed — rather than one row per edge. A node going
// offline and coming back is a single timeline entry with a start and an end,
// not a "not responding" row and an unlinked "back online" row fifteen minutes
// later. `ended_at` carries all three states; see the field's docblock in
// shared/src/schema/cluster-event.ts.
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
 * The kinds that describe a **condition** rather than a transition: something
 * that starts, persists, and later stops. They are the only rows this file ever
 * leaves open (`ended_at = ""`), and the only ones reconcileOngoing will close.
 *
 * Everything else here is an instant. A capacity change has no inverse to close
 * on — the capacity is simply the new capacity from then on. These two have a
 * state that a later scrape can re-read and find to be over: a node answering
 * again, or being listed with a role again.
 *
 * **Kept in step with shared/src/schema/cluster-event.ts by a test**, not by
 * care — a Goja hook cannot import from that workspace, so
 * cluster-events-lib.test.ts asserts the two arrays are identical, exactly as
 * it does for the four thresholds below.
 */
const ONGOING_KINDS = ["node_state", "node_removed"];

/**
 * How soon a condition may recur and still count as the same incident.
 *
 * A node that flaps every scrape used to cost two rows per interval — one
 * "not responding", one "back online" — and at 50 rows to a page a single
 * flapping node filled the admin timeline and pushed real events off it. Within
 * this window the detector re-opens the row it just closed and bumps its
 * occurrence count instead of appending another, so a flap is one entry reading
 * "3 occurrences" rather than six rows.
 *
 * Two scrape intervals. Wide enough that the common case — down at one scrape,
 * up at the next, down again at the one after — folds into a single incident;
 * narrow enough that an outage on Tuesday and an unrelated one on Thursday stay
 * two entries, which is what a reader of a timeline wants them to be.
 */
const FLAP_WINDOW_SEC = 1800;

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
    /**
     * True for an ONGOING_KINDS row: this event OPENS a condition, and the
     * writer must leave `ended_at` empty rather than stamping it closed.
     * reconcileOngoing is what routes it — it may end up re-opening an existing
     * row instead of creating this one, or dropping it because the condition is
     * already recorded as open.
     */
    ongoing: !!fields.ongoing,
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
 *   - Emission is edge-triggered, including for the two ONGOING_KINDS: this
 *     function reports that a condition STARTED, never that one is still
 *     running and never that one ended. Opening on an edge is what preserves
 *     the two guarantees above — a fresh database and a scrape after a long gap
 *     both stay silent, because "we were not looking" is not an observation.
 *     Closing is the opposite: reconcileOngoing reads current state, so a node
 *     that recovers during a cron outage is still resolved even though there is
 *     no edge left to see. Neither can invent a row — one needs two samples
 *     that disagree, the other needs a row already open.
 *
 * `failedNodeIds` is the set of nodes whose row failed to write this scrape.
 * They are missing from `curRows` for a local reason, so they are excluded from
 * the "no longer reported" pass rather than being reported as removed.
 */
function diffObservations(prevRows, curRows, failedNodeIds) {
  const events = [];
  const prev = byNode(prevRows);
  const seenNow = byNode(curRows);
  const failed = {};
  for (const id of failedNodeIds || []) failed[id] = true;

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

    // -- connectivity. An outage is a *condition*, so only the down edge is
    //    an event: it OPENS a row that stays open for as long as the node stays
    //    silent. There is deliberately no "back online" row any more. A
    //    recovery closes the row it belongs to — see reconcileOngoing — rather
    //    than filing a second, unlinked row beside it, which is what made a
    //    flapping node unreadable on the timeline.
    //
    //    Sampled every 15 minutes, so occurred_at bounds the transition to the
    //    preceding interval rather than pinning it; the page says so.
    if (!!p.is_up && !cur.is_up) {
      events.push(
        event(
          Object.assign({}, base, {
            kind: "node_state",
            ongoing: true,
            severity: "warning",
            title: label + " is not responding",
            detail:
              "The node was disconnected at this scrape. Sampling is every 15 minutes, so it went down somewhere in the preceding interval.",
            previous_value: "up",
            new_value: "down",
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
              ongoing: true,
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
  //
  // `failed` is the set of nodes whose NodeMetrics row threw while being
  // written this scrape. They are absent from curRows for a reason that has
  // nothing to do with the cluster, and reporting one as removed would be a
  // fabrication — one that now costs an *open* condition rather than a stray
  // row. scrapeOnce collects them; see the docblock.
  for (const p of prevRows || []) {
    if (seenNow[p.node_id]) continue;
    if (failed[p.node_id]) continue;
    events.push(
      event({
        kind: "node_removed",
        ongoing: true,
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
 * Is an ongoing condition still true at this scrape?
 *
 * Three answers, and the third is the one that matters: `null` means **this
 * scrape cannot tell**, and the row is left exactly as it is. Treating "cannot
 * tell" as "over" would resolve a real outage the moment the layout failed to
 * load, which is the one thing a timeline must never do.
 *
 *   true  — still going, leave the row open
 *   false — over, close the row
 *   null  — indeterminate, touch nothing
 */
function conditionActive(kind, cur, wasFailed) {
  // The node's row threw while being written. Its absence says something about
  // this process, not about the cluster.
  if (wasFailed) return null;

  if (kind === "node_state") {
    // Not reported at all. Whether that is an outage or a removal is
    // node_removed's question, and answering it here would close an outage on
    // a node that has actually vanished.
    if (!cur) return null;
    return !cur.is_up;
  }

  if (kind === "node_removed") {
    // Still not listed by Garage.
    if (!cur) return true;
    // The same gate the diff applies: role_ok means "this row was written by a
    // scraper that records the role columns", so without it a capacity of 0 is
    // indistinguishable from an absent field. Closing on that would announce a
    // node had rejoined the layout because the layout could not be read.
    if (!cur.role_ok) return null;
    return !(cur.role_capacity_bytes > 0);
  }

  return null;
}

/** `kind` and `node_id` together identify a condition. */
function conditionKey(kind, nodeId) {
  return kind + "\u0000" + (nodeId || "");
}

/**
 * Turn one scrape's detected events into the three things the writer does:
 * create rows, re-open rows, and close rows.
 *
 * **Pure, and clockless like `diffObservations`** — no Goja globals, no
 * requires, no `Date`. The flap window is not applied here: `readOpenConditions`
 * has already bounded its query by it, so every closed row in `openRows` is by
 * construction recent enough to re-open. That is what lets vitest drive this
 * across the workspace boundary.
 *
 * `openRows` is the mixed set that query returns — rows with `ended_at = ""`
 * (open now) and rows closed within the window (re-openable).
 *
 * The three passes:
 *
 *   - **close** every open row whose condition `conditionActive` says is over.
 *     Driven by current state, not by an edge, so a node that recovered during
 *     a gap in the cron is still resolved.
 *   - **drop** an opening event whose condition is already open. This is the
 *     repeat suppression: a node that stays down re-emits nothing, and neither
 *     does one whose row was opened by an earlier scrape.
 *   - **re-open** the most recently closed row for that condition if there is
 *     one, bumping its occurrence count; otherwise **create**.
 *
 * Point-in-time events pass through to `creates` untouched — every one of the
 * eleven other kinds takes this path and none of the above applies to it.
 */
function reconcileOngoing(events, curRows, openRows, failedNodeIds) {
  const seenNow = byNode(curRows);
  const failed = {};
  for (const id of failedNodeIds || []) failed[id] = true;

  const open = {};
  const recent = {};
  for (const row of openRows || []) {
    if (ONGOING_KINDS.indexOf(row.kind) === -1) continue;
    const key = conditionKey(row.kind, row.node_id);
    if (!row.ended_at) {
      open[key] = row;
      continue;
    }
    // Most recently closed wins. Dates are ISO-ish and same-length, so a string
    // comparison orders them without parsing — and without a clock.
    const held = recent[key];
    if (!held || String(row.ended_at) > String(held.ended_at)) recent[key] = row;
  }

  const creates = [];
  const reopens = [];
  const closes = [];

  for (const key in open) {
    const row = open[key];
    const active = conditionActive(
      row.kind,
      seenNow[row.node_id],
      !!failed[row.node_id]
    );
    if (active === false) closes.push({ id: row.id });
  }

  for (const e of events || []) {
    if (!e.ongoing) {
      creates.push(e);
      continue;
    }
    const key = conditionKey(e.kind, e.node_id);
    if (open[key]) continue; // already recorded — this is the noise suppression

    const prior = recent[key];
    if (prior) {
      reopens.push({
        id: prior.id,
        // A row written before the column existed reads back 0; it opened once
        // to exist at all, so this recurrence makes two.
        occurrence_count: (prior.occurrence_count || 1) + 1,
      });
      // One re-open per condition per scrape. A second opening event for the
      // same key cannot happen from one set of observations, but leaving the
      // row in `recent` would make a double-bump possible if one ever did.
      delete recent[key];
      continue;
    }
    creates.push(e);
  }

  return { creates: creates, reopens: reopens, closes: closes };
}

/**
 * The open and recently-closed conditions, as plain objects for
 * `reconcileOngoing`.
 *
 * `cutoffPbDate` bounds the re-openable half: pass now minus FLAP_WINDOW_SEC
 * and every closed row that comes back is inside the window, which is what
 * keeps the flap rule out of the pure function. Open rows are unbounded — an
 * outage that has been running for six weeks is exactly the one that must still
 * be found and closed.
 *
 * `source = "detector"` first, so `idx_clusterevents_source_ended` serves the
 * predicate. The kind filter is applied in JS rather than in the filter string:
 * it is a handful of rows either way, and the list lives in one place above.
 */
function readOpenConditions(app, cutoffPbDate) {
  const records = app.findRecordsByFilter(
    COLLECTION,
    'source = "detector" && (ended_at = "" || ended_at >= {:cutoff})',
    "-occurred_at",
    0,
    0,
    { cutoff: cutoffPbDate }
  );

  const out = [];
  for (const r of records) {
    const kind = r.getString("kind");
    if (ONGOING_KINDS.indexOf(kind) === -1) continue;
    out.push({
      id: r.id,
      kind: kind,
      node_id: r.getString("node_id"),
      ended_at: r.getString("ended_at"),
      occurrence_count: r.getInt("occurrence_count"),
    });
  }
  return out;
}

/**
 * Apply a `reconcileOngoing` plan. `occurredAt` is a PocketBase date string
 * supplied by the caller so every row touched by one scrape shares an instant —
 * and so this file needs no clock, which is what keeps the two functions above
 * testable.
 *
 * `app` must be the transactional app from the scrape: a row and the sample it
 * was derived from commit together or not at all.
 *
 * Closes run before re-opens and creates. Nothing depends on the order — the
 * plan was computed against a snapshot taken before any of these writes — but a
 * scrape that resolves one node and opens a condition on another reads better
 * in that order if it ever has to be traced through the log.
 *
 * Returns `{ created, reopened, closed }` rather than one number: "wrote 3
 * rows" and "closed 2 outages and opened 1" are different facts about a
 * cluster, and the cron line prints both.
 */
function recordEvents(app, plan, occurredAt) {
  const result = { created: 0, reopened: 0, closed: 0 };
  if (!plan) return result;

  for (const c of plan.closes || []) {
    const record = app.findRecordById(COLLECTION, c.id);
    record.set("ended_at", occurredAt);
    app.save(record);
    result.closed++;
  }

  for (const r of plan.reopens || []) {
    const record = app.findRecordById(COLLECTION, r.id);
    // Blanked, not moved: the row keeps its original occurred_at, because the
    // incident started when it started. The counter is what says it came back.
    record.set("ended_at", "");
    record.set("occurrence_count", r.occurrence_count);
    app.save(record);
    result.reopened++;
  }

  const creates = plan.creates || [];
  if (creates.length > 0) {
    const collection = app.findCollectionByNameOrId(COLLECTION);
    for (const e of creates) {
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
      // A point-in-time row is BORN CLOSED. That is what makes `ended_at = ""`
      // mean "unresolved" rather than "the detector had nothing to say", which
      // is all it meant before — see 1787800000_close_legacy_events.js, which
      // retrofits the same statement onto every row written until now.
      record.set("ended_at", e.ongoing ? "" : occurredAt);
      record.set("occurrence_count", e.ongoing ? 1 : 0);
      app.save(record);
      result.created++;
    }
  }

  return result;
}

module.exports = {
  DISK_CHANGE_TOLERANCE,
  DATA_DROP_PCT,
  DATA_DROP_MIN_BYTES,
  CLUSTER_DROP_RATIO,
  FLAP_WINDOW_SEC,
  ONGOING_KINDS,
  conditionActive,
  diffObservations,
  reconcileOngoing,
  readOpenConditions,
  recordEvents,
};
