// PocketBase JavaScript Hooks
// Documentation: https://pocketbase.io/docs/js-overview/
//
// Editor typings for the JSVM globals ($app, $os, $http, onRecordCreateRequest,
// ...) come from ../jsconfig.json, which pulls in pb_data/types.d.ts once the
// binary has written it. Do NOT re-add a triple-slash reference to that file
// here or in pb_hooks/lib/*: pb_data/ is gitignored, and webapp tests import
// from pb_hooks/lib, so the dangling reference fails tsc (TS6053) on any
// checkout that has never run PocketBase — CI included. `yarn check:refs`
// guards this.

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
// same handler, after the same e.next() — so a claim, its audit row, and its
// balance either all commit or all roll back. Splitting them into parallel hooks
// would only create a way for them to disagree.
//
// That atomicity is NOT free, and does not come from e.app: inside a request
// hook e.app is the plain request app, and the record save that e.next() runs
// commits in a transaction of its own before e.next() returns. Worse, the
// default handler writes the HTTP response from inside that same call, so by
// the time a naive post-e.next() audit write throws, the client has already been
// told the claim succeeded and the error only reaches the log.
//
// So every hook that must stay in step with its record wraps the whole thing in
// `withRecordTx`, which is the two-line dance below:
//
//     e.app.runInTransaction((txApp) => {
//       e.app = txApp;   // the save inside e.next() now joins THIS transaction
//       fn(txApp);
//     });
//
// Assigning e.app before e.next() is what makes it work — the default handler
// reads e.App to build its upsert form, and PocketBase's runInTransaction nests
// safely (a txApp's DB is already a *dbx.Tx, so the inner call runs inline).
// It also fixes the response ordering for free: PocketBase defers the response
// write to transaction-complete whenever e.App is transactional, so a failed
// audit or balance write now rolls the claim back AND surfaces as an error to
// the caller, instead of a 200 with a silently missing trail.
//
// The read-modify-write inside applyClaimDelta depends on this too. StorageNode-
// Balances has a UNIQUE (user, node_id); unwrapped, two concurrent claims on the
// same pair either collide on that constraint or clobber each other's total,
// after the claims themselves have already committed. Running it inside the
// write transaction serializes it against the other writer.
//
// withRecordTx lives in lib/record-tx.js and is `require`d inside each handler,
// for the same Goja reason as the other helpers.

onRecordCreateRequest((e) => {
  const { writeClaimAudit, resolveActor } = require(`${__hooks}/lib/claim-audit.js`);
  const { applyClaimDelta } = require(`${__hooks}/lib/storage-balance.js`);
  const { withRecordTx } = require(`${__hooks}/lib/record-tx.js`);
  withRecordTx(e, (txApp) => {
    e.next();
    const amountGb = e.record.getFloat("quota_gb");
    writeClaimAudit(txApp, {
      action: "create",
      claim: e.record,
      previousGb: 0,
      newGb: amountGb,
      actor: resolveActor(e),
    });
    applyClaimDelta(txApp, {
      userId: e.record.getString("user"),
      nodeId: e.record.getString("node_id"),
      deltaGb: amountGb,
      entryDelta: 1,
      nodeHostname: e.record.getString("node_hostname"),
      nodeZone: e.record.getString("node_zone"),
    });
  });
}, "StorageClaims");

onRecordUpdateRequest((e) => {
  const { writeClaimAudit, resolveActor } = require(`${__hooks}/lib/claim-audit.js`);
  const { applyClaimDelta } = require(`${__hooks}/lib/storage-balance.js`);
  const { withRecordTx } = require(`${__hooks}/lib/record-tx.js`);
  // original() is the record as it was loaded from the DB, before the request
  // applied its changes — read it before e.next() commits them.
  const before = e.record.original();
  const previousGb = before.getFloat("quota_gb");
  const previousNodeId = before.getString("node_id");
  const previousUserId = before.getString("user");
  withRecordTx(e, (txApp) => {
    e.next();
    const newGb = e.record.getFloat("quota_gb");
    const nodeId = e.record.getString("node_id");
    const userId = e.record.getString("user");
    writeClaimAudit(txApp, {
      action: "update",
      claim: e.record,
      previousGb: previousGb,
      newGb: newGb,
      actor: resolveActor(e),
    });

    if (previousUserId === userId && previousNodeId === nodeId) {
      // Ordinary case: the amount moved, the pair did not.
      applyClaimDelta(txApp, {
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
      applyClaimDelta(txApp, {
        userId: previousUserId,
        nodeId: previousNodeId,
        deltaGb: -previousGb,
        entryDelta: -1,
      });
      applyClaimDelta(txApp, {
        userId: userId,
        nodeId: nodeId,
        deltaGb: newGb,
        entryDelta: 1,
        nodeHostname: e.record.getString("node_hostname"),
        nodeZone: e.record.getString("node_zone"),
      });
    }
  });
}, "StorageClaims");

onRecordDeleteRequest((e) => {
  const { writeClaimAudit, resolveActor } = require(`${__hooks}/lib/claim-audit.js`);
  const { applyClaimDelta } = require(`${__hooks}/lib/storage-balance.js`);
  const { withRecordTx } = require(`${__hooks}/lib/record-tx.js`);
  const previousGb = e.record.getFloat("quota_gb");
  const userId = e.record.getString("user");
  const nodeId = e.record.getString("node_id");
  withRecordTx(e, (txApp) => {
    e.next();
    writeClaimAudit(txApp, {
      action: "delete",
      claim: e.record,
      previousGb: previousGb,
      newGb: 0,
      actor: resolveActor(e),
    });
    applyClaimDelta(txApp, {
      userId: userId,
      nodeId: nodeId,
      deltaGb: -previousGb,
      entryDelta: -1,
    });
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
  const { writeClaimAudit, resolveActor } = require(`${__hooks}/lib/claim-audit.js`);
  const { applyTransferDelta } = require(`${__hooks}/lib/storage-balance.js`);
  const { withRecordTx } = require(`${__hooks}/lib/record-tx.js`);

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

  withRecordTx(e, (txApp) => {
    e.next();

    for (const snapshot of transferSnapshots) {
      // Only the surviving counterparty needs correcting.
      applyTransferDelta(txApp, {
        fromUserId: snapshot.fromUserId === userId ? null : snapshot.fromUserId,
        toUserId: snapshot.toUserId === userId ? null : snapshot.toUserId,
        deltaGb: -snapshot.quotaGb,
      });
    }

    for (const snapshot of snapshots) {
      writeClaimAudit(txApp, {
        action: "delete",
        claim: snapshot.claim,
        previousGb: snapshot.previousGb,
        newGb: 0,
        actor: resolveActor(e),
        source: "cascade",
        userEmail: userEmail,
      });
    }
  });
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
  const { withRecordTx } = require(`${__hooks}/lib/record-tx.js`);
  withRecordTx(e, (txApp) => {
    e.next();
    applyTransferDelta(txApp, {
      fromUserId: e.record.getString("from_user"),
      toUserId: e.record.getString("to_user"),
      deltaGb: e.record.getFloat("quota_gb"),
    });
  });
}, "StorageTransfers");

onRecordDeleteRequest((e) => {
  const { applyTransferDelta } = require(`${__hooks}/lib/storage-balance.js`);
  const { withRecordTx } = require(`${__hooks}/lib/record-tx.js`);
  const fromUserId = e.record.getString("from_user");
  const toUserId = e.record.getString("to_user");
  const quotaGb = e.record.getFloat("quota_gb");
  withRecordTx(e, (txApp) => {
    e.next();
    applyTransferDelta(txApp, {
      fromUserId: fromUserId,
      toUserId: toUserId,
      deltaGb: -quotaGb,
    });
  });
}, "StorageTransfers");

// A bucket's quota_gb is the slice of its owner's grant that is already spoken
// for, so allocated_gb tracks it.
onRecordCreateRequest((e) => {
  const { applyAllocationDelta } = require(`${__hooks}/lib/storage-balance.js`);
  const { withRecordTx } = require(`${__hooks}/lib/record-tx.js`);
  withRecordTx(e, (txApp) => {
    e.next();
    applyAllocationDelta(
      txApp,
      e.record.getString("user"),
      e.record.getFloat("quota_gb")
    );
  });
}, "Buckets");

onRecordUpdateRequest((e) => {
  const { applyAllocationDelta } = require(`${__hooks}/lib/storage-balance.js`);
  const { withRecordTx } = require(`${__hooks}/lib/record-tx.js`);
  const before = e.record.original();
  const previousGb = before.getFloat("quota_gb");
  const previousUserId = before.getString("user");
  withRecordTx(e, (txApp) => {
    e.next();
    const newGb = e.record.getFloat("quota_gb");
    const userId = e.record.getString("user");

    // Most Buckets updates are the webapp's usage-cache write (bytes, objects,
    // usage_updated_at) on every dashboard load, which leaves the quota alone.
    // Skip those rather than churn a balance row on every page view.
    if (previousUserId === userId) {
      if (previousGb !== newGb) {
        applyAllocationDelta(txApp, userId, newGb - previousGb);
      }
      return;
    }
    applyAllocationDelta(txApp, previousUserId, -previousGb);
    applyAllocationDelta(txApp, userId, newGb);
  });
}, "Buckets");

onRecordDeleteRequest((e) => {
  const { applyAllocationDelta } = require(`${__hooks}/lib/storage-balance.js`);
  const { withRecordTx } = require(`${__hooks}/lib/record-tx.js`);
  const userId = e.record.getString("user");
  const quotaGb = e.record.getFloat("quota_gb");
  withRecordTx(e, (txApp) => {
    e.next();
    applyAllocationDelta(txApp, userId, -quotaGb);
  });
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
        `[storage-balance] rebuild corrected ${result.corrected} row(s), worst drift ${result.driftGb} GB — an incremental hook is missing a path`
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
        `[storage-balance] manual rebuild corrected ${result.corrected} row(s), worst drift ${result.driftGb} GB`
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
// ---------------------------------------------------------------------------
// Storage invites
// ---------------------------------------------------------------------------
//
// An invite is storage promised to an email address with no account behind it
// yet. The webapp writes the row (POST /next-api/garage/transfers, when the
// recipient lookup comes back empty); this hook is only the notification, and
// `POST /next-api/garage/invites/claim` is what later turns it into a real
// StorageTransfer.
//
// onRecordAfterCreateSuccess, deliberately, NOT a request hook wrapped in
// withRecordTx like the balance hooks: the invite is the record of the
// promise, and a bounced email must not delete it. Mail here is best-effort —
// it logs and moves on, and the sender still sees the pending invite on their
// dashboard.
onRecordAfterCreateSuccess((e) => {
  const { formatGib } = require(`${__hooks}/lib/format.js`);

  const APP_URL = $os.getenv("APP_PUBLIC_URL");
  if (!APP_URL) {
    console.warn("[storage-invite] APP_PUBLIC_URL not set; invite email skipped");
    return;
  }

  const toEmail = e.record.getString("to_email");
  const amount = formatGib(e.record.getFloat("quota_gb"));

  let senderEmail = "A garage-ware user";
  try {
    senderEmail = $app.findRecordById("users", e.record.getString("from_user")).email();
  } catch (err) {
    // The sender vanishing between write and send is not a reason to withhold
    // the invite — name them generically rather than dropping the mail.
    console.warn("[storage-invite] sender lookup failed:", err);
  }

  let html;
  try {
    html = $template
      .loadFiles(`${__hooks}/views/storage-invite-email.html`)
      .render({
        senderEmail: senderEmail,
        toEmail: toEmail,
        // Goja has no encodeURIComponent guarantee across versions; escape the
        // two characters that actually appear in addresses and matter in a query.
        toEmailEncoded: toEmail.replace(/\+/g, "%2B").replace(/@/g, "%40"),
        amount: amount,
        note: e.record.getString("note"),
        appUrl: APP_URL,
      });
  } catch (err) {
    console.error("[storage-invite] template render failed:", err);
    return;
  }

  const settings = $app.settings();
  const message = new MailerMessage({
    from: { address: settings.meta.senderAddress, name: settings.meta.senderName },
    to: [{ address: toEmail }],
    subject: `${senderEmail} sent you ${amount} of storage`,
    html: html,
  });

  try {
    $app.newMailClient().send(message);
    console.log(`[storage-invite] emailed ${toEmail} (${amount})`);
  } catch (err) {
    console.error("[storage-invite] mail send failed for:", toEmail, err);
  }
}, "StorageInvites");

cronAdd("bucket-usage-alerts", "0 9 * * *", () => {
  const { formatBytes, formatGib, formatCount } = require(`${__hooks}/lib/format.js`);

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

    // Treat unset / 0 as the default so users get alerts before they opt in.
    // Mirrors DEFAULT_NOTIFICATION_THRESHOLD_PCT in shared/src/schema/user.ts,
    // which Goja cannot import — change both together.
    const rawThreshold = user.getInt("notification_threshold_pct");
    const threshold = rawThreshold > 0 ? rawThreshold : 95;

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

// ---------------------------------------------------------------------------
// Per-node metrics time-series (NodeMetrics).
//
// Every 15 minutes: three calls to the central Garage admin API
// (GetClusterStatus, GetNodeStatistics?node=*, GetClusterLayout) become one
// NodeMetrics row per node — uptime, data/metadata partition space, resync
// queue/errors, block refcount entries, and the partitions the layout assigns
// the node. Only GetClusterStatus is fatal; the other two clear their gate
// (node_stats_ok / layout_ok) and the run continues. The scrape needs
// GARAGE_ADMIN_URL + GARAGE_ADMIN_TOKEN in the PB process env (the pb dev
// script sources ../webapp/.env; Docker passes them with `docker run -e`) and
// warns-and-skips when they are absent, like APP_PUBLIC_URL above. The same
// run prunes rows older than NODE_METRICS_RETENTION_DAYS (default 90), and
// diffs this scrape against the previous one to append any ClusterEvents rows
// the change produced, and closes the ones whose condition has since cleared —
// see pb_hooks/lib/cluster-events.js.

cronAdd("node-metrics-scrape", "*/15 * * * *", () => {
  const { scrapeOnce } = require(`${__hooks}/lib/node-metrics.js`);
  try {
    const result = scrapeOnce($app, { prune: true });
    if (result.skipped) return; // scrapeOnce already warned
    console.log(
      `[node-metrics] recorded ${result.recorded} node(s), statsFailed=${result.statsFailed}, layoutFailed=${result.layoutFailed}, pruned=${result.pruned}, events=+${result.events.created}/~${result.events.reopened}/-${result.events.closed}, errors=${result.errors}`
    );
  } catch (err) {
    console.error("[node-metrics] scrape failed:", err);
  }
});

// Scrape on demand. Superuser-only, proxied by the admin-gated Next.js route
// at /next-api/garage/node-metrics/scrape — same shape as the storage-balances
// rebuild above, and the same reason: one implementation, shared with the
// cron. Skips the prune so a manual "record a sample now" stays cheap. 503 on
// a skipped run lets the UI say "env not configured" instead of a fake OK.
routerAdd(
  "POST",
  "/api/node-metrics/scrape",
  (e) => {
    const { scrapeOnce } = require(`${__hooks}/lib/node-metrics.js`);
    const result = scrapeOnce(e.app, { prune: false });
    return e.json(result.skipped ? 503 : 200, result);
  },
  $apis.requireSuperuserAuth()
);

// Bucketed history for the /dashboard/metrics charts, proxied by the Next.js
// route at /next-api/garage/node-metrics, which any signed-in user may call
// (this endpoint itself stays superuser-only). The aggregation lives here
// rather than in the webapp because the raw window is large (30d ≈ 23k rows)
// and this read is in-process, while the webapp would have to page it over
// HTTP. Number fields that were recorded as "no reading" (see the NodeMetrics
// migration) come out of here as real JSON nulls.
routerAdd(
  "GET",
  "/api/node-metrics/history",
  (e) => {
    const { RANGES, historyFor } = require(`${__hooks}/lib/node-metrics.js`);
    const range = e.request.url.query().get("range") || "24h";
    if (!RANGES[range]) {
      return e.json(400, {
        message: `unknown range "${range}" — expected one of: ${Object.keys(RANGES).join(", ")}`,
      });
    }
    return e.json(200, historyFor(e.app, range));
  },
  $apis.requireSuperuserAuth()
);

// ---------------------------------------------------------------------------
// Account creation
// ---------------------------------------------------------------------------
//
// Two hooks on Users, both first-run concerns:
//
//   1. Who may sign up at all (SIGNUP_MODE).
//   2. Who becomes the first administrator (SETUP_OWNER_EMAIL).
//
// Both have to live here rather than in a Next.js route handler: sign-up is a
// direct client-side PocketBase call (AuthService.register -> UserMutator),
// so nothing of ours is on that path. Neither is a collection rule, because
// both are env-driven and a rule change would mean a migration.

// Gate sign-up. The decision itself is in lib/signup-gate.js — free of Goja
// globals so vitest can drive it from the webapp workspace; this hook is only
// the I/O around it.
onRecordCreateRequest((e) => {
  const { parseSignupMode, decideSignup, refusalMessage } = require(`${__hooks}/lib/signup-gate.js`);

  const email = String(e.record.email() || "").trim().toLowerCase();

  // Count admins rather than asking whether the caller is one: what matters is
  // whether ANYBODY holds the scope, which decides if we are still in the
  // bootstrap window where sign-up must stay open.
  //
  // Two failure modes, and they must NOT be treated alike. A missing Admins
  // collection means we are pre-migration, i.e. genuinely unclaimed, and
  // refusing there would brick the bootstrap. A collection that exists but
  // cannot be counted is an unknown state, and an access control that opens
  // when it cannot see is the wrong way round — refuse instead.
  let adminCount = 0;
  let collectionExists = true;
  try {
    $app.findCollectionByNameOrId("Admins");
  } catch {
    collectionExists = false;
  }
  if (collectionExists) {
    try {
      adminCount = $app.countRecords("Admins");
    } catch (err) {
      console.error("[signup] could not count admins; refusing sign-up:", err);
      throw new BadRequestError(
        "Sign-up is temporarily unavailable. Please try again shortly."
      );
    }
  }

  let hasPendingInvite = false;
  if (email) {
    try {
      // Bound parameter, not string interpolation — an address is user input.
      $app.findFirstRecordByFilter(
        "StorageInvites",
        'to_email = {:email} && status = "pending"',
        { email: email }
      );
      hasPendingInvite = true;
    } catch {
      // findFirstRecordByFilter throws when there is no match; that is the
      // "no invite" answer, not an error.
      hasPendingInvite = false;
    }
  }

  const decision = decideSignup({
    mode: parseSignupMode($os.getenv("SIGNUP_MODE")),
    email: email,
    isSuperuser: e.hasSuperuserAuth(),
    adminCount: adminCount,
    hasPendingInvite: hasPendingInvite,
    ownerEmail: String($os.getenv("SETUP_OWNER_EMAIL") || "").trim().toLowerCase(),
  });

  if (!decision.allow) {
    console.log(`[signup] refused ${email}: ${decision.reason}`);
    throw new BadRequestError(refusalMessage(decision.reason));
  }

  e.next();
}, "Users");

// Auto-promote the configured owner to administrator.
//
// The alternative to the /setup claim token, for unattended installs. Guarded
// on an EMPTY Admins collection, which is what keeps it from being a standing
// back door: once the instance is claimed, this address is just another user.
//
// onRecordAfterCreateSuccess (not a request hook) because the user record must
// exist before it can be referenced, and because a failure here must not undo
// the sign-up — same reasoning as the StorageInvites mail hook above.
onRecordAfterCreateSuccess((e) => {
  const ownerEmail = String($os.getenv("SETUP_OWNER_EMAIL") || "").trim().toLowerCase();
  if (!ownerEmail) return;

  const email = String(e.record.email() || "").trim().toLowerCase();
  if (email !== ownerEmail) return;

  try {
    if ($app.countRecords("Admins") > 0) {
      // Already claimed. Say so rather than failing silently — an operator who
      // left SETUP_OWNER_EMAIL set will otherwise wonder why it did nothing.
      console.log(`[setup] SETUP_OWNER_EMAIL matched ${email} but an administrator already exists; not promoting`);
      return;
    }
    const admins = $app.findCollectionByNameOrId("Admins");
    const record = new Record(admins);
    record.set("user", e.record.id);
    $app.save(record);
    console.log(`[setup] promoted ${email} to administrator via SETUP_OWNER_EMAIL`);
  } catch (err) {
    // Best-effort: the account is real and usable either way, and the claim
    // token remains as the other route in.
    console.error("[setup] SETUP_OWNER_EMAIL promotion failed:", err);
  }
}, "Users");

// Refuse to remove the last administrator.
//
// Every bootstrap-window relaxation keys off `Admins` being EMPTY, not off a
// one-time "has this instance ever been claimed": sign-up reopens
// (lib/signup-gate.js), SETUP_OWNER_EMAIL re-arms, /next-api/status reopens to
// any signed-in user, and `/` starts redirecting visitors to /setup. So an
// instance that loses its last admin silently reverts to a fresh install — on
// the internet, with public registration.
//
// The route there is short: Admins.deleteRule is `@collection.Admins.user ?=
// @request.auth.id`, which asks "is the caller an admin", not "is this your own
// row" — so any admin may delete any admin. And Admins.user cascades from
// Users, so an admin deleting their own account from /profile takes the row
// with it. Both paths end at zero.
//
// Making the window one-way instead would mean persisting "claimed" somewhere
// the JSVM can read on every sign-up; keeping at least one admin alive is the
// smaller and more honest guarantee — the state the relaxations describe simply
// never recurs.
onRecordDeleteRequest((e) => {
  let remaining = 0;
  try {
    remaining = $app.countRecords("Admins");
  } catch (err) {
    // Cannot tell — refuse. Wrongly blocking one demotion is recoverable;
    // wrongly allowing the last one is not.
    console.error("[admins] could not count admins; refusing delete:", err);
    throw new BadRequestError("Could not verify the administrator count. Try again.");
  }
  if (remaining <= 1) {
    throw new BadRequestError(
      "This is the only administrator. Promote someone else first — an instance with no administrator reopens public sign-up."
    );
  }
  e.next();
}, "Admins");

// The same guarantee via the other door: deleting a user cascades their Admins
// row away, and no Admins hook fires for a cascade.
onRecordDeleteRequest((e) => {
  let isAdmin = false;
  try {
    $app.findFirstRecordByFilter("Admins", "user = {:id}", { id: e.record.id });
    isAdmin = true;
  } catch {
    isAdmin = false;
  }
  if (!isAdmin) {
    e.next();
    return;
  }

  let total = 0;
  try {
    total = $app.countRecords("Admins");
  } catch (err) {
    console.error("[admins] could not count admins; refusing user delete:", err);
    throw new BadRequestError("Could not verify the administrator count. Try again.");
  }
  if (total <= 1) {
    throw new BadRequestError(
      "You are the only administrator of this instance. Promote someone else before deleting your account."
    );
  }
  e.next();
}, "Users");
