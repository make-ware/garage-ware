/// <reference path="../pb_data/types.d.ts" />
//
// Lock the write rules on AccessKeys and Buckets.
//
// Both collections carried
//   createRule/updateRule/deleteRule:
//     'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id'
// which CLAUDE.md already described as "the Route-Handler funnel is convention,
// not enforcement": PocketBase would accept a direct SDK write from a browser,
// skipping every quota invariant and every Garage-side sync.
//
// That became untenable when a Garage key or bucket became something a user can
// *claim* by proving they hold a credential (POST /next-api/garage/keys/claim
// and /buckets/claim). Under the old rules the proof was decorative: any
// signed-in user could insert an AccessKeys row naming themselves and somebody
// else's garage_key_id straight from the browser SDK, or take an existing row
// of their own and repoint its garage_bucket_id. The UNIQUE indexes stopped a
// double-claim; nothing stopped the first one being fraudulent.
//
// So all three go null, exactly as NodeOwners, StorageClaims, ClusterEvents and
// StorageClaimAudit already do, and every writer authenticates with
// getPbAsSuperuser(). Locking writes costs nothing here for the same reason it
// cost nothing on NodeOwners: claiming has to check live Garage state before it
// can be allowed, which a collection rule cannot do, so the decision was never
// going to live in a rule.
//
// READ RULES ARE DELIBERATELY UNTOUCHED. They stay self-or-admin, which is what
// lets loadOwnedKey/loadOwnedBucket resolve ownership through the *caller's own*
// client with no superuser auth — the same self-scoped-lookup trick isUserAdmin
// plays against Admins.
//
// Hand-written rather than generated: `yarn db:migrate` cannot run against this
// repo's migration history at all — see 1786200000_updated_Buckets.js.
const LOCKED = [
  ["pb_eq35ufwm9d4ca18", "AccessKeys"],
  ["pb_032yrgxtgiabbg2", "Buckets"],
];

const OPEN_RULE =
  "user = @request.auth.id || @collection.Admins.user ?= @request.auth.id";

migrate((app) => {
  for (const [id] of LOCKED) {
    const collection = app.findCollectionByNameOrId(id);
    collection.createRule = null;
    collection.updateRule = null;
    collection.deleteRule = null;
    app.save(collection);
  }
}, (app) => {
  // Reverting reopens direct browser writes to both collections, and with them
  // the claim bypass described above. Only useful alongside a code revert.
  for (const [id] of LOCKED) {
    const collection = app.findCollectionByNameOrId(id);
    collection.createRule = OPEN_RULE;
    collection.updateRule = OPEN_RULE;
    collection.deleteRule = OPEN_RULE;
    app.save(collection);
  }
});
