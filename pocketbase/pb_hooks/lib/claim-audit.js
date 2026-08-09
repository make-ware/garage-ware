//
// Builder for StorageClaimAudit rows.
//
// This lives in a plain `.js` file rather than in main.pb.js because
// PocketBase's Goja runtime runs every hook callback in a fresh executor and
// does not carry top-level declarations from main.pb.js into them. A CommonJS
// module `require`d *inside* each handler is the supported way to share code.
// Note the filename is deliberately NOT `*.pb.js` — PocketBase would then load
// it as a hook file in its own right.

const AUDIT_COLLECTION = "StorageClaimAudit";

/**
 * Classify the acting identity. `system` covers writes with no authenticated
 * request behind them (migrations, other hooks, cascade cleanups).
 */
function actorTypeOf(auth) {
  if (!auth) return "system";
  return auth.isSuperuser() ? "superuser" : "user";
}

/** Best-effort email for the claim's owner; the trail is still useful without it. */
function lookupUserEmail(app, userId) {
  if (!userId) return "";
  try {
    // Auth collections are addressed by their lowercase name in the JSVM,
    // matching the bucket-usage-alerts cron in main.pb.js.
    return app.findRecordById("users", userId).email();
  } catch (err) {
    return "";
  }
}

/**
 * Write one audit row.
 *
 * `app` must be the event's `e.app`, not the global `$app`: inside a request
 * hook that is the transactional app, so the audit row commits or rolls back
 * with the claim change it describes. Failures are intentionally allowed to
 * propagate — an audit log that silently drops entries is worse than a request
 * that fails loudly, and the rollback keeps the two in step.
 *
 * @param {core.App} app
 * @param {{
 *   action: "create"|"update"|"delete",
 *   claim: core.Record,
 *   previousGb?: number,
 *   newGb?: number,
 *   auth?: core.Record,
 *   source?: "api"|"cascade",
 *   userEmail?: string,
 * }} change
 *   `userEmail` short-circuits the owner lookup. Pass it when the owning user
 *   is being deleted in the same request, where the lookup would race the
 *   cascade and come back empty.
 */
function writeClaimAudit(app, change) {
  const claim = change.claim;
  const previousGb = Number(change.previousGb) || 0;
  const newGb = Number(change.newGb) || 0;

  const userId = claim.getString("user");
  const auth = change.auth;
  const userEmail =
    change.userEmail !== undefined
      ? change.userEmail
      : lookupUserEmail(app, userId);

  const record = new Record(app.findCollectionByNameOrId(AUDIT_COLLECTION));
  record.set("action", change.action);
  record.set("claim_id", claim.id);
  record.set("user_id", userId);
  record.set("user_email", userEmail);
  record.set("node_id", claim.getString("node_id"));
  record.set("node_hostname", claim.getString("node_hostname"));
  record.set("node_zone", claim.getString("node_zone"));
  record.set("previous_gb", previousGb);
  record.set("new_gb", newGb);
  // Signed, and directly comparable to the deltaGb the webapp's
  // assertClaimDeltaAllowed() guards on: create is +amount, delete is -amount.
  record.set("delta_gb", newGb - previousGb);
  record.set("note", claim.getString("note"));
  record.set("actor_id", auth ? auth.id : "");
  record.set("actor_email", auth ? auth.email() : "");
  record.set("actor_type", actorTypeOf(auth));
  record.set("source", change.source || "api");

  app.save(record);
}

module.exports = { writeClaimAudit };
