/// <reference path="../pb_data/types.d.ts" />
//
// Opens the StorageClaimAudit `source` enum so a grant made by a node's owner
// can be told apart from one made by an admin:
//
//   source += "node-owner"
//
// Why a third value rather than reusing "api". Every claim write now arrives as
// a superuser (see 1787200000_updated_StorageClaims.js), so `actor_type` alone
// can no longer separate them — it reads "user" for both, because the route
// hands the hook the real human either way. "api" keeps its existing meaning
// (admin console, PB admin UI, direct SDK call); "node-owner" marks a grant
// sourced from a node the actor owns. Without it, /admin/ledger cannot answer
// "which grants did node owners make", which is the whole reason the audit
// trail exists for this feature.
//
// Three things to know before editing this file — the same three
// 1787000000_updated_ClusterEvents.js documents, for the same reasons:
//
//  1. THE FIELD ID MUST STAY BYTE-IDENTICAL ("select315eg4aevr"). This mutates
//     the existing field in place via fields.getByName precisely so the id
//     cannot drift. Re-adding a select with a fresh id would create a SECOND
//     column and every existing row's `source` would read back empty.
//  2. The value array must stay in the same order as CLAIM_AUDIT_SOURCES in
//     shared/src/schema/storage-claim-audit.ts. The two are kept in sync by
//     hand, because `yarn db:migrate` cannot run against this repo's migration
//     history at all (see 1786200000_updated_Buckets.js).
//  3. `values` is REASSIGNED to a fresh array rather than pushed to. Goja does
//     not reliably propagate an in-place mutation of a slice-backed property
//     back to the Go struct; assigning a whole array does.
//
// The `down` CANNOT succeed against a database already holding rows with
// source "node-owner" — PocketBase rejects the save rather than strand values
// outside the enum. Delete those rows first:
//   DELETE FROM StorageClaimAudit WHERE source = 'node-owner';
// Note that doing so destroys audit history, which is the one thing this
// collection exists not to do. Prefer not reverting.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pb_n84agjo955ign2e") // StorageClaimAudit;

  collection.fields.getByName("source").values = ["api", "cascade", "node-owner"];

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_n84agjo955ign2e") // StorageClaimAudit;

  collection.fields.getByName("source").values = ["api", "cascade"];

  return app.save(collection);
});
