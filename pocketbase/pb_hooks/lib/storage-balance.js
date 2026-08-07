/// <reference path="../../pb_data/types.d.ts" />
//
// Maintains the StorageNodeBalances / StorageUserBalances roll-ups.
//
// Every write to those two collections goes through here — the incremental
// updates the record hooks make, and the full rebuild the cron and the admin
// route run. One module means the "apply a delta" path and the "recompute from
// scratch" path can never disagree about what the numbers mean, which matters
// because the rebuild is what audits the deltas.
//
// Lives in a plain `.js` (not `*.pb.js`, which PocketBase would load as a hook
// file in its own right) and is `require`d INSIDE each handler: Goja runs every
// callback in a fresh executor and will not carry top-level declarations from
// main.pb.js into them.
//
// All amounts are logical (post-replication) GB, matching StorageClaims.quota_gb.

const NODE_BALANCES = "StorageNodeBalances";
const USER_BALANCES = "StorageUserBalances";

/** Float noise below this is treated as zero when comparing rebuilt vs stored. */
const EPSILON = 1e-9;

function nowIso() {
  // Goja has Date; PocketBase parses this into its date field fine.
  return new Date().toISOString().replace("T", " ");
}

function findNodeBalance(app, userId, nodeId) {
  try {
    return app.findFirstRecordByFilter(
      NODE_BALANCES,
      "user = {:user} && node_id = {:node}",
      { user: userId, node: nodeId }
    );
  } catch (err) {
    return null;
  }
}

function findUserBalance(app, userId) {
  try {
    return app.findFirstRecordByFilter(USER_BALANCES, "user = {:user}", {
      user: userId,
    });
  } catch (err) {
    return null;
  }
}

function newNodeBalance(app, userId, nodeId) {
  const record = new Record(app.findCollectionByNameOrId(NODE_BALANCES));
  record.set("user", userId);
  record.set("node_id", nodeId);
  record.set("claimed_gb", 0);
  record.set("entry_count", 0);
  return record;
}

function newUserBalance(app, userId) {
  const record = new Record(app.findCollectionByNameOrId(USER_BALANCES));
  record.set("user", userId);
  record.set("claims_gb", 0);
  record.set("sent_gb", 0);
  record.set("received_gb", 0);
  record.set("allocated_gb", 0);
  record.set("last_drift_gb", 0);
  return record;
}

/**
 * Apply a signed change to one (user, node) pair and to the user's unfiltered
 * claim total.
 *
 * `entryDelta` tracks how many ledger rows back the sum: +1 on create, -1 on
 * delete, 0 on an amount edit. A pair whose entries all net to zero keeps its
 * row — the claim history is still real and the admin UI still lists it.
 */
function applyClaimDelta(app, change) {
  const userId = change.userId;
  const nodeId = change.nodeId;
  const deltaGb = Number(change.deltaGb) || 0;
  const entryDelta = Number(change.entryDelta) || 0;
  if (!userId || !nodeId) return;

  let node = findNodeBalance(app, userId, nodeId);
  if (!node) node = newNodeBalance(app, userId, nodeId);

  node.set("claimed_gb", (node.getFloat("claimed_gb") || 0) + deltaGb);
  node.set("entry_count", Math.max((node.getInt("entry_count") || 0) + entryDelta, 0));
  // Keep the freshest node metadata so the admin table can label the row
  // without joining back to the ledger.
  if (change.nodeHostname) node.set("node_hostname", change.nodeHostname);
  if (change.nodeZone) node.set("node_zone", change.nodeZone);
  app.save(node);

  let user = findUserBalance(app, userId);
  if (!user) user = newUserBalance(app, userId);
  user.set("claims_gb", (user.getFloat("claims_gb") || 0) + deltaGb);
  app.save(user);
}

/** Move `deltaGb` of sent/received between two users. Negative unwinds it. */
function applyTransferDelta(app, change) {
  const deltaGb = Number(change.deltaGb) || 0;
  if (!deltaGb) return;

  if (change.fromUserId) {
    let from = findUserBalance(app, change.fromUserId);
    if (!from) from = newUserBalance(app, change.fromUserId);
    from.set("sent_gb", Math.max((from.getFloat("sent_gb") || 0) + deltaGb, 0));
    app.save(from);
  }
  if (change.toUserId) {
    let to = findUserBalance(app, change.toUserId);
    if (!to) to = newUserBalance(app, change.toUserId);
    to.set(
      "received_gb",
      Math.max((to.getFloat("received_gb") || 0) + deltaGb, 0)
    );
    app.save(to);
  }
}

/** Adjust how much of a user's grant their buckets reserve. */
function applyAllocationDelta(app, userId, deltaGb) {
  const delta = Number(deltaGb) || 0;
  if (!userId || !delta) return;
  let user = findUserBalance(app, userId);
  if (!user) user = newUserBalance(app, userId);
  user.set(
    "allocated_gb",
    Math.max((user.getFloat("allocated_gb") || 0) + delta, 0)
  );
  app.save(user);
}

/**
 * Recompute every balance from the ledgers.
 *
 * This is the audit of the incremental path, not just a repair: anything it has
 * to correct means a hook missed a write, so the size of the correction is
 * recorded on the row (`last_drift_gb`) and returned, rather than quietly
 * fixed. Returns { users, nodes, corrected, driftGb }.
 */
function rebuildAll(app) {
  const stamp = nowIso();

  const claims = app.findRecordsByFilter("StorageClaims", "1=1", "", 0, 0);
  const transfers = app.findRecordsByFilter("StorageTransfers", "1=1", "", 0, 0);
  const buckets = app.findRecordsByFilter("Buckets", "1=1", "", 0, 0);

  // (user::node) -> { userId, nodeId, gb, count, hostname, zone }
  const nodeAgg = {};
  // userId -> { claims, sent, received, allocated }
  const userAgg = {};

  function userSlot(userId) {
    if (!userAgg[userId]) {
      userAgg[userId] = { claims: 0, sent: 0, received: 0, allocated: 0 };
    }
    return userAgg[userId];
  }

  for (const claim of claims) {
    const userId = claim.getString("user");
    const nodeId = claim.getString("node_id");
    if (!userId || !nodeId) continue;
    const gb = claim.getFloat("quota_gb") || 0;
    const key = userId + "::" + nodeId;
    if (!nodeAgg[key]) {
      nodeAgg[key] = {
        userId: userId,
        nodeId: nodeId,
        gb: 0,
        count: 0,
        hostname: "",
        zone: "",
      };
    }
    nodeAgg[key].gb += gb;
    nodeAgg[key].count += 1;
    if (!nodeAgg[key].hostname) {
      nodeAgg[key].hostname = claim.getString("node_hostname");
    }
    if (!nodeAgg[key].zone) nodeAgg[key].zone = claim.getString("node_zone");
    userSlot(userId).claims += gb;
  }

  for (const transfer of transfers) {
    const gb = transfer.getFloat("quota_gb") || 0;
    const from = transfer.getString("from_user");
    const to = transfer.getString("to_user");
    if (from) userSlot(from).sent += gb;
    if (to) userSlot(to).received += gb;
  }

  for (const bucket of buckets) {
    const owner = bucket.getString("user");
    if (owner) userSlot(owner).allocated += bucket.getFloat("quota_gb") || 0;
  }

  let corrected = 0;
  let driftGb = 0;
  // Node-level corrections are folded into the owning user's `last_drift_gb`
  // below, so "which user is affected" is answerable from the balance row
  // rather than only from the aggregate return value.
  const nodeDriftByUser = {};

  function noteNodeDrift(userId, diff) {
    corrected += 1;
    driftGb += diff;
    nodeDriftByUser[userId] = (nodeDriftByUser[userId] || 0) + diff;
  }

  // --- node balances -------------------------------------------------------
  const existingNodes = app.findRecordsByFilter(NODE_BALANCES, "1=1", "", 0, 0);
  const seenNodeKeys = {};
  for (const row of existingNodes) {
    const key = row.getString("user") + "::" + row.getString("node_id");
    seenNodeKeys[key] = row;
  }

  for (const key in nodeAgg) {
    const want = nodeAgg[key];
    let row = seenNodeKeys[key];
    const had = row ? row.getFloat("claimed_gb") || 0 : 0;
    if (!row) row = newNodeBalance(app, want.userId, want.nodeId);
    const diff = want.gb - had;
    if (Math.abs(diff) > EPSILON || !seenNodeKeys[key]) {
      noteNodeDrift(want.userId, diff);
    }
    row.set("claimed_gb", want.gb);
    row.set("entry_count", want.count);
    if (want.hostname) row.set("node_hostname", want.hostname);
    if (want.zone) row.set("node_zone", want.zone);
    row.set("recomputed_at", stamp);
    app.save(row);
  }

  // A pair with no ledger entries left should not keep a stale row.
  for (const key in seenNodeKeys) {
    if (nodeAgg[key]) continue;
    const orphan = seenNodeKeys[key];
    const had = orphan.getFloat("claimed_gb") || 0;
    if (Math.abs(had) > EPSILON) {
      noteNodeDrift(orphan.getString("user"), -had);
    }
    app.delete(orphan);
  }

  // --- user balances -------------------------------------------------------
  const existingUsers = app.findRecordsByFilter(USER_BALANCES, "1=1", "", 0, 0);
  const seenUserRows = {};
  for (const row of existingUsers) seenUserRows[row.getString("user")] = row;

  for (const userId in userAgg) {
    const want = userAgg[userId];
    let row = seenUserRows[userId];
    const hadClaims = row ? row.getFloat("claims_gb") || 0 : 0;
    const hadSent = row ? row.getFloat("sent_gb") || 0 : 0;
    const hadReceived = row ? row.getFloat("received_gb") || 0 : 0;
    const hadAllocated = row ? row.getFloat("allocated_gb") || 0 : 0;
    if (!row) row = newUserBalance(app, userId);

    const ownDrift =
      want.claims -
      hadClaims +
      (want.sent - hadSent) +
      (want.received - hadReceived) +
      (want.allocated - hadAllocated);
    if (Math.abs(ownDrift) > EPSILON || !seenUserRows[userId]) {
      corrected += 1;
      driftGb += ownDrift;
    }
    // Surface node-level corrections against the user they belong to.
    const rowDrift = ownDrift + (nodeDriftByUser[userId] || 0);
    delete nodeDriftByUser[userId];

    row.set("claims_gb", want.claims);
    row.set("sent_gb", want.sent);
    row.set("received_gb", want.received);
    row.set("allocated_gb", want.allocated);
    row.set("recomputed_at", stamp);
    row.set("last_drift_gb", Math.abs(rowDrift) > EPSILON ? rowDrift : 0);
    app.save(row);
  }

  for (const userId in seenUserRows) {
    if (userAgg[userId]) continue;
    app.delete(seenUserRows[userId]);
  }

  return {
    users: Object.keys(userAgg).length,
    nodes: Object.keys(nodeAgg).length,
    corrected: corrected,
    driftGb: driftGb,
  };
}

module.exports = {
  applyClaimDelta,
  applyTransferDelta,
  applyAllocationDelta,
  rebuildAll,
};
