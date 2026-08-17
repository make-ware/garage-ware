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
 * Sources a route handler may assert over the wire. Anything else falls back to
 * "api" rather than failing the save: the column is a select field, and a value
 * outside the enum would be rejected by PocketBase and roll back the claim
 * write it was meant to describe. Keep in step with CLAIM_AUDIT_SOURCES in
 * shared/src/schema/storage-claim-audit.ts. "cascade" is deliberately absent —
 * it is set by the hook that knows it applies, never claimed by a caller.
 */
const HEADER_SOURCES = { api: true, "node-owner": true };

/**
 * Classify the acting identity. `system` covers writes with no authenticated
 * request behind them (migrations, other hooks, cascade cleanups).
 */
function actorTypeOf(auth) {
  if (!auth) return "system";
  return auth.isSuperuser() ? "superuser" : "user";
}

/**
 * Resolve who is really behind a claim write.
 *
 * Since StorageClaims' write rules became null, EVERY claim write arrives
 * authenticated as the deployment's PocketBase superuser — so `e.auth` names a
 * service account and not the human who pressed the button. Attributing owner
 * grants to that account would gut the audit trail for exactly the actor it
 * matters most for, so /next-api/garage/claims sends the real identity in
 * request headers and this resolves them.
 *
 * The `hasSuperuserAuth()` check IS the security property. Headers are trivially
 * forged by anything that can make a request, so they are honoured only when the
 * request is already authenticated with credentials no browser holds. Under any
 * other auth the headers are ignored outright and `e.auth` is the answer — which
 * also means this stays correct if a write path is ever opened up again.
 *
 * A superuser acting through the PocketBase admin UI sends no headers and is
 * attributed as `superuser`, which is the honest reading.
 *
 * Deliberately takes only the event and returns a plain object: no Goja
 * globals, no `require`, no clock. That is what lets vitest drive it across the
 * workspace boundary, the same arrangement as signup-gate.js and
 * cluster-events.js.
 *
 * @param {core.RecordRequestEvent} e
 * @returns {{ id: string, email: string, type: string, source: string }}
 */
function resolveActor(e) {
  const auth = e.auth;
  const fallback = {
    id: auth ? auth.id : "",
    email: auth ? auth.email() : "",
    type: actorTypeOf(auth),
    source: "api",
  };

  if (!e.hasSuperuserAuth()) return fallback;

  // Header keys arrive normalized to lowercase with "-" replaced by "_"
  // (docs/PB_FILTERS.md). Guard the lookup rather than the whole function: a
  // failure to read headers should cost attribution precision, never the write.
  let headers;
  try {
    headers = e.requestInfo().headers || {};
  } catch (err) {
    return fallback;
  }

  const id = headers["x_claim_actor_id"] || "";
  if (!id) return fallback;

  const source = headers["x_claim_source"] || "api";
  return {
    id: id,
    email: headers["x_claim_actor_email"] || "",
    // A named human, even though the transport was a superuser session.
    type: "user",
    source: HEADER_SOURCES[source] ? source : "api",
  };
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
 *   actor?: { id: string, email: string, type: string, source: string },
 *   source?: "api"|"cascade"|"node-owner",
 *   userEmail?: string,
 * }} change
 *   `actor` comes from resolveActor(e); omitting it records a `system` write.
 *   `source` overrides the actor's own, and exists for the cascade path, which
 *   knows something about how the write arrived that the actor cannot.
 *   `userEmail` short-circuits the owner lookup. Pass it when the owning user
 *   is being deleted in the same request, where the lookup would race the
 *   cascade and come back empty.
 */
function writeClaimAudit(app, change) {
  const claim = change.claim;
  const previousGb = Number(change.previousGb) || 0;
  const newGb = Number(change.newGb) || 0;

  const userId = claim.getString("user");
  const actor = change.actor || { id: "", email: "", type: "system", source: "api" };
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
  record.set("actor_id", actor.id);
  record.set("actor_email", actor.email);
  record.set("actor_type", actor.type);
  record.set("source", change.source || actor.source || "api");

  app.save(record);
}

module.exports = { writeClaimAudit, resolveActor };
