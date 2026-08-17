/// <reference path="../pb_data/types.d.ts" />
//
// Locks all three StorageClaims write rules to null.
//
// They were '@collection.Admins.user ?= @request.auth.id', which meant an admin
// could create, edit or delete a ledger entry straight from the browser SDK and
// skip assertClaimDeltaAllowed entirely — every per-node, per-user and
// allocation invariant with it. CLAUDE.md called that out as a known weakness
// ("the Route-Handler funnel is convention, not enforcement").
//
// Node ownership is what forces the issue: a node owner is not an admin, so
// their write has to be made as a superuser anyway. Once one write path
// authenticates as a superuser, having a second, weaker one open to browsers
// buys nothing. After this migration /next-api/garage/claims is the only way
// in, and the funnel is genuine enforcement for this collection. (It remains
// convention for AccessKeys and Buckets, whose rules are untouched.)
//
// Superusers still bypass rules, so the PocketBase admin UI keeps working; such
// a write is audited as actor_type "superuser", which is correct.
//
// Verified before writing this: no browser-side code writes StorageClaims —
//   grep -rn "collection('StorageClaims')" webapp/src | grep -v next-api
// returns nothing. Re-check if this is ever reverted.
//
// Hand-written; `yarn db:migrate` cannot run against this repo's migration
// history (see 1786200000_updated_Buckets.js). Mirrors
// shared/src/schema/storage-claim.ts — keep the two in sync by hand.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;

  collection.createRule = null;
  collection.updateRule = null;
  collection.deleteRule = null;

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;

  collection.createRule = "@collection.Admins.user ?= @request.auth.id";
  collection.updateRule = "@collection.Admins.user ?= @request.auth.id";
  collection.deleteRule = "@collection.Admins.user ?= @request.auth.id";

  return app.save(collection);
});
