import {
  baseSchema,
  defineCollection,
  RelationField,
  TextField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

/**
 * Ownership of one Garage cluster node by one PocketBase user.
 *
 * A user who contributed hardware claims the node by supplying its full Garage
 * node id, and may thereafter append StorageClaims entries sourced from it —
 * to themselves or to any other user. Ownership decides *who may append a row*,
 * never *how much*: every claim written by an owner passes through exactly the
 * same `assertClaimDeltaAllowed` invariants an admin's write does, so a node
 * can no more be over-claimed by its owner than by anybody else.
 *
 * `node_id` holds the node **key** — the first 16 characters of the id, the
 * form `garage status` prints — not the full id the claimer typed. The full id
 * is the credential the route accepts as proof of access to the machine, and it
 * is matched against the live layout and then discarded: a credential kept in a
 * database is a credential that can leak from one. This is what closed the
 * ACCEPTED GAP that stood here, under which every full node id was readable
 * from `GET /next-api/garage/cluster/nodes` and from `NodeMetrics` rows
 * (listRule `@request.auth.id != ''`), making a claim first-come-first-served
 * among signed-in users. A prefix was chosen over the `HMAC(node_id)` surrogate
 * that note proposed, because it matches the CLI and gives nothing away: 192
 * bits of the id remain unknown. See webapp/src/lib/node-label.ts.
 *
 * There is deliberately NO `node_hostname` / `node_zone` snapshot, unlike
 * StorageClaims. Node names resolve at display time from the live layout (see
 * webapp/src/lib/node-label.ts) — the frozen snapshots on StorageClaims and
 * StorageClaimAudit are precisely how one node came to render two different
 * labels on two different pages.
 */
export const NodeOwnerSchema = z
  .object({
    user: RelationField({ collection: 'Users', cascadeDelete: true }),
    /** The node key, never a full node id. See the header. */
    node_id: TextField().min(1).max(128),
    /** The owner's own words: "the box in the garage", "rack 4 spare". */
    note: TextField({ max: 500 }).optional(),
  })
  .extend(baseSchema);

export const NodeOwnerInputSchema = z.object({
  user: z.string().min(1),
  node_id: z.string().min(1).max(128),
  note: z.string().max(500).optional(),
});

export const NodeOwnerCollection = defineCollection({
  collectionName: 'NodeOwners',
  schema: NodeOwnerSchema,
  permissions: {
    // Reads are self-or-admin, which is what lets `assertNodeOwner` resolve
    // ownership through the *caller's* own client with no superuser auth: a
    // lookup by node id returns the row iff the caller owns it. Same
    // self-scoped-lookup trick as `isUserAdmin` against Admins.
    listRule:
      'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    viewRule:
      'user = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    // All three null, as on ClusterEvents and StorageClaimAudit. Claiming has
    // to check the live cluster layout before it can be allowed, which a
    // collection rule cannot do, so the route handlers write as a superuser and
    // locking writes costs nothing.
    createRule: null,
    updateRule: null,
    deleteRule: null,
  },
  indexes: [
    // UNIQUE, and it is the concurrency control rather than a mere constraint.
    // webapp/src/lib/setup/claim.ts had to narrow its read-then-write race with
    // a process-global promise mutex and admits that does not span replicas;
    // here the database expresses "one owner per node" directly, so there is no
    // mutex and no backoff — two simultaneous claims mean one insert and one
    // uniqueness violation, which the route maps to 409.
    'CREATE UNIQUE INDEX `idx_nodeowners_node` ON `NodeOwners` (`node_id`)',
    'CREATE INDEX `idx_nodeowners_user` ON `NodeOwners` (`user`)',
  ],
});

export default NodeOwnerCollection;

export type NodeOwner = z.infer<typeof NodeOwnerSchema>;
export type NodeOwnerInput = z.infer<typeof NodeOwnerInputSchema>;
