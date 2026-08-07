/// <reference path="./pb_data/types.d.ts" />
// PocketBase JavaScript Hooks
// Documentation: https://pocketbase.io/docs/js-overview/

// ---------------------------------------------------------------------------
// StorageClaims audit trail
// ---------------------------------------------------------------------------
//
// StorageClaims is an append-only ledger, but only of the rows that currently
// exist: PATCH /next-api/garage/claims/[id] rewrites an entry's amount and
// DELETE removes it outright, and neither leaves any trace of who did it or
// what the value was before. These hooks record that, into StorageClaimAudit.
//
// Why hooks and not the Next.js route handlers, which already know the actor
// and the before/after: the hooks also catch writes made through the PocketBase
// admin UI or a direct SDK call. Those are precisely the writes an audit trail
// exists for, and the route handlers never see them.
//
// Why the *Request* variants rather than onRecordAfter*Success: only
// RecordRequestEvent carries `e.auth` (it embeds RequestEvent), and attributing
// the actor is the whole point. The tradeoff is that request hooks do not fire
// for rows removed by a cascade delete, which the Users hook below covers.
//
// Each handler requires its helper inside the callback: Goja runs every hook in
// a fresh executor, so a top-level require here would not be visible to them.

// The claim hooks below do double duty: they write the audit trail AND keep the
// StorageNodeBalances / StorageUserBalances roll-ups current. Both happen in the
// same handler, after the same e.next(), on the same transactional e.app — so a
// claim, its audit row, and its balance either all commit or all roll back.
// Splitting them into parallel hooks would only create a way for them to
// disagree.

onRecordCreateRequest((e) => {
  const { writeClaimAudit } = require(`${__hooks}/lib/claim-audit.js`);
  const { applyClaimDelta } = require(`${__hooks}/lib/storage-balance.js`);
  e.next();
  const amountGb = e.record.getFloat("quota_gb");
  writeClaimAudit(e.app, {
    action: "create",
    claim: e.record,
    previousGb: 0,
    newGb: amountGb,
    auth: e.auth,
    source: "api",
  });
  applyClaimDelta(e.app, {
    userId: e.record.getString("user"),
    nodeId: e.record.getString("node_id"),
    deltaGb: amountGb,
    entryDelta: 1,
    nodeHostname: e.record.getString("node_hostname"),
    nodeZone: e.record.getString("node_zone"),
  });
}, "StorageClaims");

onRecordUpdateRequest((e) => {
  const { writeClaimAudit } = require(`${__hooks}/lib/claim-audit.js`);
  const { applyClaimDelta } = require(`${__hooks}/lib/storage-balance.js`);
  // original() is the record as it was loaded from the DB, before the request
  // applied its changes — read it before e.next() commits them.
  const before = e.record.original();
  const previousGb = before.getFloat("quota_gb");
  const previousNodeId = before.getString("node_id");
  const previousUserId = before.getString("user");
  e.next();
  const newGb = e.record.getFloat("quota_gb");
  const nodeId = e.record.getString("node_id");
  const userId = e.record.getString("user");
  writeClaimAudit(e.app, {
    action: "update",
    claim: e.record,
    previousGb: previousGb,
    newGb: newGb,
    auth: e.auth,
    source: "api",
  });

  if (previousUserId === userId && previousNodeId === nodeId) {
    // Ordinary case: the amount moved, the pair did not.
    applyClaimDelta(e.app, {
      userId: userId,
      nodeId: nodeId,
      deltaGb: newGb - previousGb,
      entryDelta: 0,
      nodeHostname: e.record.getString("node_hostname"),
      nodeZone: e.record.getString("node_zone"),
    });
  } else {
    // The entry was re-pointed at a different user or node. Nothing in the app
    // does this, but the PB admin UI can — move the whole entry rather than
    // leaving its old pair overstated.
    applyClaimDelta(e.app, {
      userId: previousUserId,
      nodeId: previousNodeId,
      deltaGb: -previousGb,
      entryDelta: -1,
    });
    applyClaimDelta(e.app, {
      userId: userId,
      nodeId: nodeId,
      deltaGb: newGb,
      entryDelta: 1,
      nodeHostname: e.record.getString("node_hostname"),
      nodeZone: e.record.getString("node_zone"),
    });
  }
}, "StorageClaims");

onRecordDeleteRequest((e) => {
  const { writeClaimAudit } = require(`${__hooks}/lib/claim-audit.js`);
  const { applyClaimDelta } = require(`${__hooks}/lib/storage-balance.js`);
  const previousGb = e.record.getFloat("quota_gb");
  const userId = e.record.getString("user");
  const nodeId = e.record.getString("node_id");
  e.next();
  writeClaimAudit(e.app, {
    action: "delete",
    claim: e.record,
    previousGb: previousGb,
    newGb: 0,
    auth: e.auth,
    source: "api",
  });
  applyClaimDelta(e.app, {
    userId: userId,
    nodeId: nodeId,
    deltaGb: -previousGb,
    entryDelta: -1,
  });
}, "StorageClaims");

// Deleting a user cascades to their StorageClaims rows at the model layer, with
// no per-row HTTP request — so the delete hook above never sees them. Record
// them here instead.
//
// The claims and the user's email have to be read *before* e.next(), while both
// still exist, but the audit rows are only written *after* it succeeds: writing
// first would leave the trail claiming a deletion that a failed request never
// performed. The deleted claim records stay readable in memory afterwards.
onRecordDeleteRequest((e) => {
  const { writeClaimAudit } = require(`${__hooks}/lib/claim-audit.js`);
  const { applyTransferDelta } = require(`${__hooks}/lib/storage-balance.js`);

  const userId = e.record.id;
  const userEmail = e.record.email();

  let claims = [];
  try {
    claims = e.app.findRecordsByFilter(
      "StorageClaims",
      "user = {:userId}",
      "-created",
      0,
      0,
      { userId: userId }
    );
  } catch (err) {
    console.error("[claim-audit] cascade lookup failed for user:", userId, err);
  }

  const snapshots = claims.map((claim) => ({
    claim: claim,
    previousGb: claim.getFloat("quota_gb"),
  }));

  // StorageTransfers cascades from BOTH parties, so deleting this user also
  // silently removes the transfers they sent and received — and the transfer
  // hooks below never fire for a cascade. The counterparty's sent_gb/received_gb
  // would stay overstated until the nightly rebuild, and a validator reading it
  // in the meantime would let them over-allocate. Unwind their side here.
  // This user's own balance rows cascade away, so they need no adjustment.
  let transfers = [];
  try {
    transfers = e.app.findRecordsByFilter(
      "StorageTransfers",
      "from_user = {:userId} || to_user = {:userId}",
      "",
      0,
      0,
      { userId: userId }
    );
  } catch (err) {
    console.error(
      "[storage-balance] cascade transfer lookup failed for user:",
      userId,
      err
    );
  }

  const transferSnapshots = transfers.map((transfer) => ({
    fromUserId: transfer.getString("from_user"),
    toUserId: transfer.getString("to_user"),
    quotaGb: transfer.getFloat("quota_gb"),
  }));

  e.next();

  for (const snapshot of transferSnapshots) {
    // Only the surviving counterparty needs correcting.
    applyTransferDelta(e.app, {
      fromUserId: snapshot.fromUserId === userId ? null : snapshot.fromUserId,
      toUserId: snapshot.toUserId === userId ? null : snapshot.toUserId,
      deltaGb: -snapshot.quotaGb,
    });
  }

  for (const snapshot of snapshots) {
    writeClaimAudit(e.app, {
      action: "delete",
      claim: snapshot.claim,
      previousGb: snapshot.previousGb,
      newGb: 0,
      auth: e.auth,
      source: "cascade",
      userEmail: userEmail,
    });
  }
}, "Users");

// ---------------------------------------------------------------------------
// Storage balance roll-ups
// ---------------------------------------------------------------------------
//
// StorageNodeBalances / StorageUserBalances are a cache of the two ledgers,
// maintained here so that reading a user's position costs O(nodes) instead of
// O(ledger entries). The ledgers only ever grow, and every per-user sum used to
// read a single page of them — a silent wrong answer waiting on row count.
//
// The claim side is handled in the StorageClaims hooks above (same handler as
// the audit trail, so the two cannot diverge). What is left is transfers,
// bucket allocations, and keeping the whole thing honest.

// A transfer has no update path — it is corrected by deleting it — so create
// and delete are the only two events.
onRecordCreateRequest((e) => {
  const { applyTransferDelta } = require(`${__hooks}/lib/storage-balance.js`);
  e.next();
  applyTransferDelta(e.app, {
    fromUserId: e.record.getString("from_user"),
    toUserId: e.record.getString("to_user"),
    deltaGb: e.record.getFloat("quota_gb"),
  });
}, "StorageTransfers");

onRecordDeleteRequest((e) => {
  const { applyTransferDelta } = require(`${__hooks}/lib/storage-balance.js`);
  const fromUserId = e.record.getString("from_user");
  const toUserId = e.record.getString("to_user");
  const quotaGb = e.record.getFloat("quota_gb");
  e.next();
  applyTransferDelta(e.app, {
    fromUserId: fromUserId,
    toUserId: toUserId,
    deltaGb: -quotaGb,
  });
}, "StorageTransfers");

// A bucket's quota_gb is the slice of its owner's grant that is already spoken
// for, so allocated_gb tracks it.
onRecordCreateRequest((e) => {
  const { applyAllocationDelta } = require(`${__hooks}/lib/storage-balance.js`);
  e.next();
  applyAllocationDelta(
    e.app,
    e.record.getString("user"),
    e.record.getFloat("quota_gb")
  );
}, "Buckets");

onRecordUpdateRequest((e) => {
  const { applyAllocationDelta } = require(`${__hooks}/lib/storage-balance.js`);
  const before = e.record.original();
  const previousGb = before.getFloat("quota_gb");
  const previousUserId = before.getString("user");
  e.next();
  const newGb = e.record.getFloat("quota_gb");
  const userId = e.record.getString("user");

  // Most Buckets updates are the webapp's usage-cache write (bytes, objects,
  // usage_updated_at) on every dashboard load, which leaves the quota alone.
  // Skip those rather than churn a balance row on every page view.
  if (previousUserId === userId) {
    if (previousGb !== newGb) {
      applyAllocationDelta(e.app, userId, newGb - previousGb);
    }
    return;
  }
  applyAllocationDelta(e.app, previousUserId, -previousGb);
  applyAllocationDelta(e.app, userId, newGb);
}, "Buckets");

onRecordDeleteRequest((e) => {
  const { applyAllocationDelta } = require(`${__hooks}/lib/storage-balance.js`);
  const userId = e.record.getString("user");
  const quotaGb = e.record.getFloat("quota_gb");
  e.next();
  applyAllocationDelta(e.app, userId, -quotaGb);
}, "Buckets");

// Nightly full recompute. This is the audit of the incremental hooks above, not
// routine maintenance: a non-zero `corrected` means one of them missed a write
// path, so it is logged loudly and recorded per-row in `last_drift_gb`.
cronAdd("storage-balance-rebuild", "30 3 * * *", () => {
  const { rebuildAll } = require(`${__hooks}/lib/storage-balance.js`);
  try {
    const result = rebuildAll($app);
    if (result.corrected > 0) {
      console.warn(
        `[storage-balance] rebuild corrected ${result.corrected} row(s), net drift ${result.driftGb} GB — an incremental hook is missing a path`
      );
    } else {
      console.log(
        `[storage-balance] rebuild clean: ${result.users} user(s), ${result.nodes} node balance(s)`
      );
    }
  } catch (err) {
    console.error("[storage-balance] rebuild failed:", err);
  }
});

// Note there is deliberately no onBootstrap backfill here. Migrations run
// *after* bootstrap fires, so on the boot that upgrades an existing deployment
// a hook-based backfill finds no collections and does nothing — leaving the
// cache empty on exactly the installation that has data to backfill. The
// initial population lives in 1786122444_created_StorageUserBalances.js
// instead, where it is atomic with the schema change.

// Force a rebuild on demand. Superuser-only, and proxied by the admin-gated
// Next.js route at /next-api/garage/storage-balances/rebuild — keeping the
// recompute here means there is exactly one implementation of it, shared with
// the cron above, rather than a second one in TypeScript that could disagree.
routerAdd(
  "POST",
  "/api/storage-balances/rebuild",
  (e) => {
    const { rebuildAll } = require(`${__hooks}/lib/storage-balance.js`);
    const result = rebuildAll(e.app);
    if (result.corrected > 0) {
      console.warn(
        `[storage-balance] manual rebuild corrected ${result.corrected} row(s), net drift ${result.driftGb} GB`
      );
    }
    return e.json(200, result);
  },
  $apis.requireSuperuserAuth()
);

// Daily reminder for buckets at or over the user's notification_threshold_pct.
// DB-only: reads cached `bytes` + `usage_updated_at` written back by the webapp
// when users visit /dashboard/buckets. Does NOT call Garage. A bucket without
// a fresh `usage_updated_at` (never visited) is skipped — by design, the email
// nudges users back to the dashboard, where the next refresh updates the cache.
//
// Helpers (formatBytes/formatGib) are defined *inside* the handler because
// PocketBase's Goja runtime runs each hook callback in a fresh executor and
// does not import top-level function declarations from main.pb.js. Keep this
// formatter in sync by hand with webapp/src/lib/format.ts.
cronAdd("bucket-usage-alerts", "0 9 * * *", () => {
  const formatBytes = (bytes) => {
    if (!isFinite(bytes)) return String(bytes);
    const KB = 1e3, MB = 1e6, GB = 1e9, TB = 1e12, PB = 1e15;
    const abs = Math.abs(bytes);
    let value, unit;
    if (abs >= PB) { value = bytes / PB; unit = "PB"; }
    else if (abs >= TB) { value = bytes / TB; unit = "TB"; }
    else if (abs >= GB) { value = bytes / GB; unit = "GB"; }
    else if (abs >= MB) { value = bytes / MB; unit = "MB"; }
    else if (abs >= KB) { value = bytes / KB; unit = "KB"; }
    else return bytes + " B";
    let s = value.toFixed(2);
    if (s.indexOf(".") !== -1) s = s.replace(/\.?0+$/, "");
    return s + " " + unit;
  };
  // Stored quota_gb is binary GiB; bridge into bytes for the formatter so the
  // email matches what the dashboard renders.
  const formatGib = (gib) => formatBytes(gib * 1024 * 1024 * 1024);
  // Thousands separators for object counts. Goja's Intl support is limited, so
  // do it by hand rather than relying on Number.prototype.toLocaleString.
  const formatCount = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  const APP_URL = $os.getenv("APP_PUBLIC_URL");
  if (!APP_URL) {
    console.warn("[bucket-usage-alerts] APP_PUBLIC_URL not set; skipping run");
    return;
  }

  const GIB = 1024 * 1024 * 1024;
  let emailedUsers = 0;
  let checkedBuckets = 0;
  let skippedBuckets = 0;
  let errors = 0;

  // Only consider buckets with a quota set and a cached usage reading.
  const buckets = $app.findRecordsByFilter(
    "Buckets",
    "quota_gb > 0 && usage_updated_at != ''",
    "-updated",
    0,
    0
  );

  // Group by owning user.
  const byUser = {};
  for (const b of buckets) {
    const uid = b.getString("user");
    if (!byUser[uid]) byUser[uid] = [];
    byUser[uid].push(b);
  }

  const settings = $app.settings();
  const senderAddress = settings.meta.senderAddress;
  const senderName = settings.meta.senderName;

  for (const uid in byUser) {
    let user;
    try {
      user = $app.findRecordById("users", uid);
    } catch (err) {
      errors++;
      console.error("[bucket-usage-alerts] user lookup failed:", uid, err);
      continue;
    }

    // Profile UI caps at 90; treat unset / 0 as 90 so users get the default.
    const rawThreshold = user.getInt("notification_threshold_pct");
    const threshold = rawThreshold > 0 ? rawThreshold : 90;

    const offenders = [];
    for (const b of byUser[uid]) {
      checkedBuckets++;
      const quotaGb = b.getFloat("quota_gb");
      const bytes = b.getInt("bytes");
      const objects = b.getInt("objects");
      const maxObjects = b.getInt("max_objects");
      if (quotaGb <= 0) {
        skippedBuckets++;
        continue;
      }

      // A bucket alerts when EITHER its storage fill or its object-count fill
      // is at/over the threshold. The object cap is optional (max_objects > 0
      // only when GARAGE_AVG_OBJECT_SIZE_MB is configured on the webapp).
      const sizePctFull = (bytes / (quotaGb * GIB)) * 100;
      const hasObjectQuota = maxObjects > 0;
      const objectPctFull = hasObjectQuota ? (objects / maxObjects) * 100 : 0;
      const sizeOver = sizePctFull >= threshold;
      const objectOver = hasObjectQuota && objectPctFull >= threshold;
      if (!sizeOver && !objectOver) continue;

      const lastCheckedRaw = b.getString("usage_updated_at");
      offenders.push({
        id: b.id,
        name: b.getString("name"),
        pctFull: Math.round(sizePctFull * 10) / 10,
        used: formatBytes(bytes),
        quota: formatGib(quotaGb),
        sizeOver: sizeOver,
        hasObjectQuota: hasObjectQuota,
        objectPctFull: Math.round(objectPctFull * 10) / 10,
        objectsUsed: formatCount(objects),
        maxObjects: formatCount(maxObjects),
        objectOver: objectOver,
        lastChecked: lastCheckedRaw ? lastCheckedRaw.slice(0, 10) : "—",
      });
    }

    if (offenders.length === 0) continue;

    let html;
    try {
      html = $template
        .loadFiles(`${__hooks}/views/bucket-alert-email.html`)
        .render({
          threshold: threshold,
          buckets: offenders,
          appUrl: APP_URL,
        });
    } catch (err) {
      errors++;
      console.error(
        "[bucket-usage-alerts] template render failed for user:",
        uid,
        err
      );
      continue;
    }

    const message = new MailerMessage({
      from: { address: senderAddress, name: senderName },
      to: [{ address: user.email() }],
      subject: `Storage alert: ${offenders.length} bucket${offenders.length === 1 ? "" : "s"} over ${threshold}%`,
      html: html,
    });

    try {
      $app.newMailClient().send(message);
      emailedUsers++;
    } catch (err) {
      errors++;
      console.error(
        "[bucket-usage-alerts] mail send failed for user:",
        uid,
        err
      );
    }
  }

  console.log(
    `[bucket-usage-alerts] emailed ${emailedUsers} user(s), checked ${checkedBuckets} bucket(s), skipped ${skippedBuckets}, errors=${errors}`
  );
});
