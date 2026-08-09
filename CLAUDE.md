# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app is

`garage-ware` is the management/control plane for a self-hosted [Garage HQ](https://garagehq.deuxfleurs.fr/) S3-compatible storage cluster. Four features:

1. **Cluster administration** — admins view live cluster status/health/layout/nodes.
2. **Storage claims with replication factor** — admins grant users storage per cluster node as an append-only ledger of signed adjustments; a user's total claim is the sum of their entries, and they allocate slices of it as per-bucket quotas. Replication factor is read live from Garage's layout.
3. **Storage transfers** — a user (or an admin on their behalf) hands part of their *unallocated* claim to another user, found by email. Also append-only; "returning" a transfer means deleting the row. An address with no account yet gets a **StorageInvite** instead: the same handoff held in escrow, emailed to the recipient, and converted to a real transfer when they sign up — see [Storage invites](#storage-invites).
4. **Storage user self-service** — users manage their own S3 access keys, buckets, per-key bucket permissions, and live usage.

The one formula to keep in your head — a user's **net granted GB**:

```
netGranted = sum(claims on nodes still in the layout) + sum(transfers received) − sum(transfers sent)
available  = netGranted − sum(bucket.quota_gb)              # what they may still allocate
```

Never hand-roll it. Server-side, read it from `getUserGrantedGb()` (a single number) or `getUserStorageSummary()` (the full position) — see [Storage accounting](#storage-accounting).

**Source-of-truth split.** Garage owns buckets, keys, layout, and usage data. PocketBase owns identity (Users, Admins), the Garage↔user mappings (`AccessKeys.user`, `Buckets.user`), and the two claim ledgers (StorageClaims, StorageTransfers) — which have no Garage counterpart at all, since Garage has no concept of a user. PocketBase intentionally does **not** duplicate Garage state — anything Garage knows authoritatively is proxied live, never mirrored. `NodeMetrics` is the deliberate second exception (after the `Buckets` usage cache): Garage only exposes *instantaneous* values, so a 15-minute history has no authoritative source to proxy — recording it is sampling, not mirroring. Deeper cluster metrics (throughput, request rates) still live in InfluxDB + Grafana, not here.

`GarageClusterCache` is the third, and the only one that *is* a mirror: a stale-while-revalidate cache of the layout, status, health, and replication factor, holding the raw response body under a unique `key` with the timestamp Garage answered. It exists because every dashboard load re-fetched the layout three times over plus a cluster-wide status fan-out, none of which is realtime data. It is written and read only by the Next.js handlers through [webapp/src/lib/garage/cached.ts](webapp/src/lib/garage/cached.ts) — no hook, no cron, all five collection rules `null`, superuser-only (a raw layout carries node addresses the browser is never handed). **Display paths only.** Every storage invariant is enforced against the layout, so claim mutations, transfer sends and returns, bucket quota validation, and invite settlement all keep fetching live: being a minute out of date is harmless for showing a number and unsafe for checking one. Payloads are re-parsed through the zod schemas in `lib/garage/schemas.ts` on every read, and a payload that no longer parses counts as a miss — Garage v2 may still change shape.

The one narrow exception: `Buckets.bytes`, `Buckets.objects`, `Buckets.max_size`, `Buckets.max_objects`, and `Buckets.usage_updated_at` are a cache, refreshed by the webapp's `/next-api/garage/buckets/*` handlers when a user views the dashboard — since [Cluster read cache](#cluster-read-cache), *behind* the response rather than before it, and also **read** by `GET /buckets` instead of only written — and consumed by the daily `bucket-usage-alerts` cron in [pocketbase/pb_hooks/main.pb.js](pocketbase/pb_hooks/main.pb.js). The cron is intentionally DB-only (no Garage call); stale data is acceptable because the alert nudges users back to the dashboard, which refreshes the cache. (These mirror Garage's reported usage and quotas in raw Garage units: `max_size`/`max_objects` are the byte/object caps Garage currently enforces. `quota_gb` stays the authoritative size quota and drives the cron's byte-fill check; `max_size` is the convenience byte mirror, while `max_objects` lets the cron alert on object-count fill. Don't confuse `max_objects` — a mirror of what Garage enforces — with `object_quota`, which is the authoritative override for what it *should* enforce.)

## Workspace layout

Yarn v4 monorepo (`packageManager: "yarn@4.12.0"`) with three workspaces:

- `webapp/` (`@garage-ware/webapp`) — Next.js 16 + React 19 + Tailwind v4 + shadcn/ui frontend. Mostly client-side; server-side code is confined to `webapp/src/app/next-api/*` (Route Handlers) and the `import 'server-only'` libraries they call — `webapp/src/lib/garage/`, `lib/auth/server.ts`, and most of `lib/storage/`.
- `shared/` (`@garage-ware/shared`) — ESM TypeScript package: zod schemas, collection definitions, mutators, types, error utilities. Built with tsup. Subpath exports: `./schema`, `./mutators`, `./mutator`, `./types`, `./enums` — see [shared/package.json](shared/package.json).
- `pocketbase/` (`@garage-ware/pb`) — PocketBase binary, hooks ([pocketbase/pb_hooks/main.pb.js](pocketbase/pb_hooks/main.pb.js)), migrations ([pocketbase/pb_migrations/](pocketbase/pb_migrations/)), and the [seed-admin script](pocketbase/scripts/seed-admin.mjs). The folder is `pocketbase/` for local-dev clarity; the production Docker image keeps the in-image path at `/app/pb/`.

`shared/dist/` must exist for `webapp` to compile — run `yarn workspace @garage-ware/shared build` after pulling or after editing anything under `shared/src/`.

## Common commands

```bash
# Initial setup (downloads PocketBase binary)
yarn install && yarn setup

# Run everything: webapp + shared (watch) + pb
yarn dev

# Per-workspace dev
yarn workspace @garage-ware/webapp dev     # Next.js on :3000
yarn workspace @garage-ware/pb dev         # ./pocketbase/pocketbase serve on :8090
yarn workspace @garage-ware/shared dev     # tsup watch

# Build / quality (all run via `yarn workspaces foreach`)
yarn build         # all workspaces
yarn lint          # lint:fix everywhere
yarn lint:check    # lint without fix (CI uses this)
yarn typecheck
yarn format        # prettier write
yarn format:check
yarn test          # every test actually lives in webapp — shared's `test` is a stub echo
yarn precommit     # build:shared + lint + typecheck + format + test

# Single test (vitest) — example: just the Garage client tests
yarn workspace @garage-ware/webapp test src/lib/garage/garage-client.test.ts
yarn workspace @garage-ware/webapp test -t 'assertClaimDeltaAllowed'   # by test/describe name

# Migrations (generated from shared/src/schema/ collection definitions)
yarn db:migrate    # alias for: yarn workspace @garage-ware/shared migrate:generate
yarn db:status

# PocketBase admin (create the superuser via the binary)
yarn workspace @garage-ware/pb admin

# Promote an existing user to app-admin (needs POCKETBASE_ADMIN_EMAIL/PASSWORD;
# falls back to webapp/.env, like the pb `dev` script). The user must already exist.
yarn workspace @garage-ware/pb seed-admin <user-email>
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs: `yarn install --immutable` → `build` → `format:check` → `lint:check` → `typecheck` → `test`. Match this order locally before pushing.

## Repo location and release pipeline

The canonical remote is **`github.com/make-ware/garage-ware`** (private; moved from `dastron/garage-ware`). Container images publish to **`ghcr.io/make-ware/garage-ware`**.

Three workflows, none of which hardcode the owner — the image name comes from `${{ github.repository }}` and auth from the built-in `GITHUB_TOKEN`, so another move needs no workflow edits:

| Workflow | Trigger | Does |
|---|---|---|
| [ci.yml](.github/workflows/ci.yml) | push/PR on `main` | the quality gate above |
| [release-please.yml](.github/workflows/release-please.yml) | push on `main` | maintains a release PR (bumps [package.json](package.json) + [.release-please-manifest.json](.release-please-manifest.json), writes [CHANGELOG.md](CHANGELOG.md)); on merge tags `vX.Y.Z`, cuts a release, then calls docker-build |
| [docker-build.yml](.github/workflows/docker-build.yml) | `workflow_call` from release-please, a `v*.*.*` tag push, a published release, or manual dispatch | builds `linux/amd64` + `linux/arm64` in parallel, pushes by digest, then merges one multi-arch manifest tagged `vX.Y.Z` + `latest` |

Notes when touching these:

- **Conventional commits are load-bearing.** release-please derives the version bump and changelog from `feat:` / `fix:` / `feat!:` prefixes. A non-conventional commit message produces no release entry.
- **Version lives in three places** — [package.json](package.json), [.release-please-manifest.json](.release-please-manifest.json), and the `v*` git tag. release-please owns all three; never bump by hand.
- **`org.opencontainers.image.source`** is set on both the per-arch images and the merged manifest. That label is what links the GHCR package to this repo (and so makes the package inherit repo access) — keep it if you rewrite the labels block.
- The repo is private, so the GHCR package is too: pulling needs `docker login ghcr.io` with a PAT carrying `read:packages`.
- Tags and releases that release-please itself creates do **not** re-trigger workflows (`GITHUB_TOKEN`-authored events never do) — that's why release-please invokes docker-build via `workflow_call` rather than relying on the tag-push trigger. The `push: tags` / `release: published` triggers are for human-created tags and releases.

## Required env vars

See [.env.example](.env.example) — [webapp/.env.example](webapp/.env.example) is a byte-identical copy, so edit both or neither. The split matters:

- `NEXT_PUBLIC_POCKETBASE_URL` — browser-visible; the webapp's PB client uses this.
- `POCKETBASE_URL` / `POCKETBASE_ADMIN_EMAIL` / `POCKETBASE_ADMIN_PASSWORD` — server-only; used by the migration tool, the `seed-admin` script, and the `getPbAsSuperuser()` helper for trusted admin operations. The email and password are **required** by [shared/pocketbase-migrate.config.js](shared/pocketbase-migrate.config.js), which throws a named error rather than falling back to a default credential.
- `GARAGE_ADMIN_URL` / `GARAGE_ADMIN_TOKEN` — **server-only**; consumed by [webapp/src/lib/garage/](webapp/src/lib/garage/) **and** (via `$os.getenv`) by the PocketBase `node-metrics-scrape` cron, so the PB process must see them too — the pb workspace `dev` script sources `../webapp/.env` for exactly this reason, and in Docker they arrive via `docker run -e`. The cron warns-and-skips when they are unset. The bearer token must never appear in any `NEXT_PUBLIC_*` var or anywhere a client bundle could see it.
- `GARAGE_S3_ENDPOINT` / `GARAGE_S3_REGION` — the S3 gateway URL (**required, no default** — an unset value makes `/next-api/config` return a 500 rather than silently falling back to some other cluster's gateway) and region (default `us-east-1`) used by the in-app file browser ([webapp/src/lib/s3/browser.ts](webapp/src/lib/s3/browser.ts)) and the bucket "connect" page. These are **non-secret public values** but are intentionally **runtime** server-side env (no `NEXT_PUBLIC_` prefix), served to the browser at request time by the [`/next-api/config`](webapp/src/app/next-api/config/route.ts) route and fetched client-side via [webapp/src/lib/s3/config.ts](webapp/src/lib/s3/config.ts) (`useS3Config()`). The point is deployability: a `NEXT_PUBLIC_*` var is inlined into the client bundle at build time, so one image could only ever target one gateway; reading them at runtime lets the same image be pointed at any cluster via plain env (e.g. a k8s pod `env:`) with no rebuild. The file browser still runs **entirely client-side**: it signs S3 requests in the browser with **user-supplied credentials** (the secret is typed into the credential gate, kept only in `sessionStorage` for the tab, and never sent to our server or persisted by PB) — no token lives in env, only the endpoint + region. Because the browser talks to the gateway directly, **each bucket must allow CORS** from the app's origin (methods GET/PUT/HEAD, the `authorization`/`x-amz-*`/`content-type` request headers, `ETag` exposed) or the browser blocks the requests.
- `GARAGE_AVG_OBJECT_SIZE_MB` — **optional, server-only**. Average object size in MB. When set, the `/next-api/garage/buckets` handlers derive each bucket's Garage `maxObjects` quota from its byte quota (`maxObjects = floor(quota_bytes / (this × 1MB))`, at least 1) whenever a quota is created or changed; the bucket details page surfaces the resulting object cap, and the daily `bucket-usage-alerts` cron emails when a bucket's object-count fill crosses the user's threshold (it reads the cached `Buckets.objects`/`Buckets.max_objects`). Leave unset to apply no object-count cap (`maxObjects` stays `null`). Read at request time via `process.env` (see [webapp/src/lib/storage/object-quota.ts](webapp/src/lib/storage/object-quota.ts)). **The derivation is only the default** — a bucket carrying an `object_quota` override ignores this value entirely; see [Object quotas](#object-quotas).
- `GARAGE_PUBLIC_S3_ENDPOINT` — **optional, server-only**. The endpoint *advertised to users* on the bucket "connect" page for their own tools (aws cli, rclone). Served as `s3PublicEndpoint` by [`/next-api/config`](webapp/src/app/next-api/config/route.ts) and falls back to `GARAGE_S3_ENDPOINT`. Set it when the URL you publish differs from the CORS-enabled gateway the in-app file browser must talk to — the browser always uses `GARAGE_S3_ENDPOINT`.
- `APP_PUBLIC_URL` — server-only, read via `$os.getenv` by the PocketBase `bucket-usage-alerts` cron **and** the `StorageInvites` create hook, to build absolute CTA links in emails. Must reach the PB process (in Docker, pass via `docker run -e`). Unset and each logs a warning and skips — for invites that means the row is still written and visible to the sender, but nobody is told.
- `NODE_METRICS_RETENTION_DAYS` — **optional, server-only**, read via `$os.getenv` by the `node-metrics-scrape` cron: days of `NodeMetrics` history to keep (older rows are pruned each run). Default 90; `0` keeps everything.

## Architecture

End-to-end flow:

```
Browser                                                 Garage cluster
  │                                                          ▲
  ├─► PocketBase :8090 (client-side SDK) ── reads: Users, Admins, AccessKeys,
  │                                          Buckets, StorageClaims, StorageTransfers
  │
  └─► Next.js :3000 ─► /next-api/garage/* Route Handlers (server-only)
                          │  reads PB session via Bearer token
                          │  authorizes via Admins / ownership check in PB
                          ▼
                       lib/garage/  ── bearer-auth fetch client → Garage admin API v2
```

Two parallel back ends, two different auth boundaries:

- **PocketBase** is reached directly from the browser using the JS SDK ([webapp/src/lib/pocketbase.ts](webapp/src/lib/pocketbase.ts)). All consumer files use `'use client'`. PB's collection rules enforce per-user access. Rationale: [docs/PB_SSR.md](docs/PB_SSR.md).
- **Garage admin API** is server-side only, proxied through Next.js Route Handlers under [webapp/src/app/next-api/garage/](webapp/src/app/next-api/garage/). The handler reads the PB auth token from the `Authorization: Bearer <token>` header (sent by [webapp/src/lib/api-client.ts](webapp/src/lib/api-client.ts)), verifies it via `pb.collection('Users').authRefresh()`, authorizes (admin via Admins collection, ownership via `AccessKeys.user`/`Buckets.user`), and only then calls Garage with the cluster bearer token.

### Data model

| Collection | Fields | Role |
|---|---|---|
| `Users` (PB auth) | `notification_threshold_pct` | Identity + per-account fill-alert threshold (10–90, integer, default 90). No storage field — the user's claim is derived from the two ledgers below. |
| `Admins` | `user: relation(Users)` | Membership grants the admin scope. Listed/viewed only by admins (the rule self-references `@collection.Admins`). |
| `AccessKeys` | `user`, `garage_key_id`, `name` | Maps a Garage S3 access-key ID to a PB user. Secret is shown once at creation, never persisted. |
| `Buckets` | `user`, `garage_bucket_id`, `name`, `quota_gb`, `object_quota`, `bytes`, `objects`, `max_size`, `max_objects`, `usage_updated_at` | Maps a Garage bucket to its owning PB user; `quota_gb` is mirrored to Garage's per-bucket quota and slices the user's total claim. `object_quota` (count, 0/unset = derive) is the **authoritative** object-cap override — see [Object quotas](#object-quotas). `bytes`/`objects`/`max_size`/`max_objects`/`usage_updated_at` are a usage cache refreshed on dashboard reads, consumed by the daily alert cron. `max_size` (bytes) mirrors `quota_gb`; `max_objects` (count, 0 = no cap) mirrors the `maxObjects` Garage currently enforces — a cache, **not** the intent. |
| `StorageClaims` | `user`, `node_id`, `node_hostname`, `node_zone`, `quota_gb`, `note` | **Append-only ledger** of per-node grants, admin-written. One row is one signed adjustment (`quota_gb` may be negative to reclaim), not a state snapshot — a user's effective claim on a node is the sum of their rows for it, and their total claim is the sum across all nodes. `note` records why (e.g. "upgraded to 8TB disk"). `(user, node_id)` is indexed but deliberately **not unique**. |
| `StorageTransfers` | `from_user`, `to_user`, `quota_gb`, `note` | **Append-only ledger** of user→user handoffs of already-granted capacity. `quota_gb` is always positive (min 0.001) and flows `from_user → to_user`; there is no update path, and deleting a row is how a recipient "returns" it. Node-agnostic by design — a transfer carries no `node_id`. |
| `StorageInvites` | `from_user`, `to_email`, `quota_gb`, `note`, `status`, `settled_at`, `transfer_id`, `failure_reason` | A transfer whose recipient has no account yet. `to_email` is a **`TextField`, not a relation** — the row exists precisely because the user does not — stored lowercased so the claim lookup is a plain equality match. `status` is `pending` \| `claimed` \| `failed`; cancelling is a delete, as with transfers. **An invite promises, it does not reserve** — see [Storage invites](#storage-invites). |
| `StorageClaimAudit` | `action`, `claim_id`, `user_id`, `user_email`, `node_id`, `node_hostname`, `node_zone`, `previous_gb`, `new_gb`, `delta_gb`, `note`, `actor_id`, `actor_email`, `actor_type`, `source` | **Immutable audit trail** of every mutation to `StorageClaims`, written by the hooks in [pocketbase/pb_hooks/main.pb.js](pocketbase/pb_hooks/main.pb.js). Admin-readable; all three write rules are `null`, since the hooks write through the Go/JSVM layer, which bypasses collection rules. Every reference is a **`TextField`, not a relation** — `StorageClaims.user` cascades from Users, so a relation would erase the trail exactly when it matters; `claim_id` is expected to dangle after its entry is deleted. See [Claim audit trail](#claim-audit-trail). |
| `StorageNodeBalances` | `user`, `node_id`, `claimed_gb`, `entry_count`, `node_hostname`, `node_zone`, `recomputed_at` | **Materialized roll-up** of the claim ledger, one row per `(user, node)`. A cache, hook-maintained. Unlike the audit collection, `user` **cascades** and `(user, node_id)` **is unique** — this is derived data, and letting the DB enforce one row per pair turns a hook bug into a loud error. See [Storage balances](#storage-balances). |
| `StorageUserBalances` | `user`, `claims_gb`, `sent_gb`, `received_gb`, `allocated_gb`, `recomputed_at`, `last_drift_gb` | Node-agnostic half of the same cache: transfers in/out and what the user's buckets reserve. `claims_gb` is the **unfiltered** cross-node sum and is *not* the granted figure — see the warning in [Storage balances](#storage-balances). |
| `NodeMetrics` | `node_id`, `node_hostname`, `node_zone`, `is_up`, `node_stats_ok`, `resync_queue_length`, `resync_errored_blocks`, `data_total_bytes`, `data_available_bytes`, `meta_total_bytes`, `meta_available_bytes` | **Per-node time-series**, one row per node per 15-minute `node-metrics-scrape` cron tick (sample time = autodate `created`; retention via `NODE_METRICS_RETENTION_DAYS`). Admin-readable, all write rules `null` (the cron writes via the JSVM). Node identity is a **`TextField`, not a relation** — nodes aren't PB entities. PB number fields can't hold null, so "no reading" is encoded: `node_stats_ok` gates the two resync fields, and `*_total_bytes = 0` means "no partition data" (gateway node); the bucketed history route emits real JSON `null`s for those. Readable by **any signed-in user** (list/view `@request.auth.id != ''`) — cluster health is visible without exposing who stores what: the cluster map reads each node's latest row straight from PB, while `GET /next-api/garage/node-metrics` stays the door for *history*, since the bucketing must run server-side. Recording a sample (`POST .../node-metrics/scrape`) stays admin-only. |
| `GarageClusterCache` | `key`, `payload`, `fetched_at` | **Stale-while-revalidate cache** of the Garage cluster reads, one row per `key` (`layout` \| `status` \| `health` \| `replication_factor`, unique index). `payload` is the raw response body (the repo's only `JSONField`; `replication_factor` stores `{ replicationFactor: n }` so every payload is an object) and is re-parsed through `lib/garage/schemas.ts` on read — a payload that no longer parses is a miss. `fetched_at` is when Garage answered, **not** the autodate `updated`, which moves on any write. **All five rules `null`**, superuser-only, no hook and no cron: [webapp/src/lib/garage/cached.ts](webapp/src/lib/garage/cached.ts) is the only reader and writer. See [Cluster read cache](#cluster-read-cache). |

**PB write rules are not `null` — the Route-Handler funnel is convention, not enforcement.** `AccessKeys`/`Buckets` allow `user = @request.auth.id || <admin>` on create/update/delete, `StorageClaims` is admin-only, `StorageTransfers` lets the sender create and the recipient delete. So PB would happily *accept* a direct SDK write from the browser — and every quota invariant and every Garage-side sync would be skipped. All app writes go through `/next-api/garage/*`; keep it that way, and don't read the permissive rules as license to write from a component.

For `AccessKeys`/`Buckets`, a handler writes PB first, calls Garage, and rolls back the PB row on Garage failure (Garage first, PB second for deletes). `StorageClaims`/`StorageTransfers` have no Garage counterpart, so their handlers are pure PB writes fronted by a validator.

#### Storage accounting

**One formula, one implementation.** `computeStorageSummary()` in [webapp/src/lib/storage/ledger-math.ts](webapp/src/lib/storage/ledger-math.ts) is the only place the net-granted arithmetic exists. That module is deliberately the *second* file under `lib/storage/` without `import 'server-only'` (alongside `units.ts`), because the admin console and the dashboard need the same roll-ups client-side — and when they each hand-rolled their own, they disagreed about whether a claim on a decommissioned node counts. It does not. Anything that sums a ledger, values a node, or rolls entries up per node belongs here, not in a component:

- `computeStorageSummary(claims, sent, received, allocatedGb, layout?)` — the whole position.
- `rollUpClaimsByUserNode` / `rollUpClaimsByNode` — signed entries collapsed per pair or per node, newest-first history included, plus a `presentInLayout` flag.
- `nodeUsableGbFrom(capacityBytes, rf)` / `nodeUsableGbInLayout(layout, nodeId, rf)` — `capacity / replicationFactor`.
- `filterPresentClaims`, `presentNodeIdSet`, `sumClaimsByNode`, `sumClaimsByUserNode`, `sumTransfers`, `userNodeKey`.

- `computeSummaryFromBalances(nodeBalances, userBalance, layout?)` — the same position from the materialized roll-ups. **It must always agree with `computeStorageSummary`**; that equivalence is asserted directly in [ledger-math.test.ts](webapp/src/lib/storage/ledger-math.test.ts) and is what makes the cache safe to read.

Three server-side helpers wrap it with the fetching. All of them read the **balances**, not the ledgers:

- `getUserGrantedGb(pb, userId, { onlyPresent, layout })` — [webapp/src/lib/storage/claims.ts](webapp/src/lib/storage/claims.ts). Net granted GB: claims + received − sent. `onlyPresent: true` (which every validator passes) drops claims on nodes missing from the live layout, so decommissioned hardware can't back a bucket; transfers are never filtered, since they aren't node-scoped.
- `getUserStorageSummary(pb, userId, layout?)` — [webapp/src/lib/storage/summary.ts](webapp/src/lib/storage/summary.ts). The whole position in one object (`claimsGb`, `sentGb`, `receivedGb`, `netGrantedGb`, `allocatedGb`, `availableGb`, plus `nodeClaims` and the transfer rows). This is the read path for the dashboard and admin views.
- `getStorageSummariesForUsers(pb, userIds, layout?)` — same summary for many users, in 2 queries regardless of user count. Backs `GET /next-api/garage/users`. Use it for any list view; the per-user helper in a loop is both slow and, historically, how the admin list drifted. It returns no transfer *rows* — a list view wants totals.

The fetching lives in [webapp/src/lib/storage/balances.ts](webapp/src/lib/storage/balances.ts) (`getUserBalances`, `getNodeClaimedGb`, `getUserNodeClaimedGb`, `getAllBalances`).

The old per-row aggregates on the mutators — `StorageClaimMutator.sumByUser/sumByNode/sumByUserAndNode`, `StorageTransferMutator.sumSentByUser/sumReceivedByUser`, `BucketMutator.sumAllocatedGb` — still exist but **nothing in the accounting path uses them any more**, because each reads a single page (200–1000 rows) of a collection that only grows. Don't reach for them in a new guard; read a balance instead.

From the browser, don't reassemble a user's position out of PB reads: `GET /next-api/garage/storage-summary` returns `getUserStorageSummary()` for the caller, or for `?userId=` when the caller is an admin. Same `?userId=`-or-self, admin-gated shape is used by `/next-api/garage/transfers`. `GET /next-api/garage/users` (admin) returns each user's full position as `net_granted_gb` / `allocated_gb` / `available_gb` — **not** a raw claim sum. Because it needs the layout to value claims, it reads the cached layout, the same way `/storage-summary` does — so with Garage unreachable both serve the last one seen rather than failing, and only a cold cache (nothing ever stored) still errors. Riding out an outage on a layout that changes when an operator changes it is the point; the invariant checks that must not be a minute behind never touch this cache.

**Four storage invariants:**
- Per user: `sum(bucket.quota_gb for user) ≤ netGranted(user)` — checked anywhere either side of that inequality moves: the bucket handlers (allocation up), `assertClaimDeltaAllowed` (claim down), and both transfer handlers (capacity out or clawed back).
- Per node: `sum(claim.quota_gb on node) ≤ node.capacity / replicationFactor`.
- Per user *and* node: `sum(claim.quota_gb for user on node) ≥ 0`. Without this, a user could hold −5 TB on one node and +5 TB on another and net out fine, while the negative rows silently freed capacity on the first node for other users to over-claim.
- Per transfer: a sender may only give away capacity they have *not* already allocated (`netGranted − allocated`), and a transfer may only be returned if the recipient still covers their buckets without it (else 409). Sending also subtracts what pending invites have promised — but invites are outside the invariant proper; see [Storage invites](#storage-invites).

Because ledger rows are signed, the first three checks reduce to the same question — *what does the sum look like after this delta?* — so `assertClaimDeltaAllowed()` in [webapp/src/lib/storage/claim-ledger.ts](webapp/src/lib/storage/claim-ledger.ts) is the single guard for **every** claim mutation: POST passes `+amount`, DELETE passes `−amount`, PATCH passes `new − old` (and skips the guard entirely when that's zero, e.g. a note-only edit). No entry needs excluding from the sums. It reads the live layout via `loadClaimContext()`. Tests: [claim-ledger.test.ts](webapp/src/lib/storage/claim-ledger.test.ts).

A claim on a node absent from the layout can only be wound down, never grown. The `onlyPresent` filter already values such claims at 0, so retiring one never strands a bucket.

Reversing a grant should normally **append a negative entry**, not delete the original — DELETE exists to fix mistyped entries and rewrites history. Both the admin claims table and the user dashboard roll entries up per `(user, node)` / per node before display (via `rollUpClaimsByUserNode` / `rollUpClaimsByNode`), so the ledger never leaks into the UI as duplicate node rows. The admin "Set claim" action takes a new *total* and appends `target − current` for the same reason: restating a position must not mean rewriting how it was reached.

Per-node claims are an *accounting* construct, not data placement — Garage spreads each bucket's data across all storage nodes per its layout, so a claim doesn't pin a user's bytes to a node. Transfers lean on that: because they're node-agnostic, moving capacity between users changes neither side's per-node sums, so the node-capacity invariant is untouched and `sum(claims on node)` stays the honest measure of what a node has promised.

#### Storage invites

`StorageTransfers.to_user` is a relation, so a handoff has always needed the recipient to already exist — and the recipient lookup ran under the caller's own auth, where the Users listRule (`self or admin`) 404s for anyone else. Between them, transfers were admin-only in practice. `StorageInvites` and a superuser lookup fix both.

`POST /next-api/garage/transfers` takes one email and decides: a known address gets a `StorageTransfers` row immediately, an unknown one gets a `StorageInvites` row. The sender is not asked which case they are in — that would be asking them to know something about the recipient that is none of their business.

- **The lookup runs as a superuser** (`findUserIdByEmail` in [webapp/src/lib/storage/invites.ts](webapp/src/lib/storage/invites.ts)), which is what makes user-to-user transfers work at all. Name the cost: whoever calls it learns whether an address has an account. It is confined to the transfer path, where the caller already knows the address they typed. The same superuser read labels transfer rows with counterparty emails for the dashboard — `GET /next-api/garage/transfers` returns `from_email` / `to_email`, because a list of raw PB ids told the recipient nothing about who had sent them a terabyte.
- **An invite promises; it does not reserve.** No balance moves until it becomes a transfer, so the balance hooks ignore the collection entirely and all four invariants keep one definition apiece. The mitigation on the writing side is `getPendingInviteGb()`, subtracted from available capacity when *sending* — one gigabyte cannot be promised to five people. It is deliberately **not** subtracted when allocating a bucket: that would put a promise inside the per-user invariant. So a sender who invites and then fills their buckets can leave an invite unpayable, and that is a state the claim path has to handle rather than prevent.
- **The claim is a route handler, not a signup hook.** `POST /next-api/garage/invites/claim` converts every pending invite for the caller's address; the dashboard calls it on load, which is what makes "sign up and the storage is there" true. A PB hook could not do this job correctly — settling an invite needs the sender's *layout-filtered* position, and a hook cannot reach Garage to learn which nodes are still in the layout (the same reason `StorageUserBalances.claims_gb` is stored unfiltered). Here the check is character-for-character the one guarding a direct transfer.
- Invites settle **oldest first and strictly in sequence**, because each conversion changes the sender's available capacity and the next invite from that sender must see it. Running them concurrently would let two invites both pass a check only one can afford. A sender who has run out does not block the rest: that invite goes to `failed` with a reason the sender reads on their dashboard.
- The claim is idempotent — an invite leaves `pending` on the first pass either way — so calling it every dashboard load costs one indexed lookup. It is also non-fatal on the client: it needs Garage for the layout, and a dashboard that refused to render because an optional pickup failed would be the worse trade.
- The **email is a separate hook**, `onRecordAfterCreateSuccess` on `StorageInvites` in [pocketbase/pb_hooks/main.pb.js](pocketbase/pb_hooks/main.pb.js) — deliberately *not* a request hook wrapped in `withRecordTx` like the balance hooks. The invite is the record of the promise, and a bounced email must not delete it, so mail is best-effort: it logs and moves on. It links to `/signup?email=…`, which prefills the address (`SignupForm`'s `defaultEmail`) — signing up with a different one leaves the invite unclaimed.

Tests: [invites.test.ts](webapp/src/lib/storage/invites.test.ts) drives the claim against a fake PocketBase and a scripted sender position.

#### Claim audit trail

`StorageClaims` is append-only, but only over the rows that *currently exist* — a PATCH rewrites an amount and a DELETE removes an entry, and neither leaves a trace. `StorageClaimAudit` is that trace, and the hooks at the top of [pocketbase/pb_hooks/main.pb.js](pocketbase/pb_hooks/main.pb.js) write it.

- **Hooks, not route handlers.** The handlers already know the actor and the before/after, so writing it there would be simpler — but the hooks also catch writes made through the PocketBase admin UI or a direct SDK call, which is precisely what an audit trail is for.
- **`*Request` hooks specifically.** Only `RecordRequestEvent` carries `e.auth` (it embeds `RequestEvent`); `onRecordAfter*Success` gets a `RecordEvent` with no actor. The cost is that request hooks don't fire for cascade deletes, so a fourth hook on `Users` snapshots the user's claims and email *before* `e.next()` and writes them as `source: 'cascade'` *after* it succeeds.
- **`withRecordTx`, never a bare `e.app`.** Inside a request hook `e.app` is *not* transactional — the record save that `e.next()` runs commits on its own, and PocketBase writes the HTTP response from inside that same call. Anything written afterwards against `e.app` is an unprotected write against an already-committed record that has already been reported as successful. [pocketbase/pb_hooks/lib/record-tx.js](pocketbase/pb_hooks/lib/record-tx.js) wraps the handler in `e.app.runInTransaction()` and reassigns `e.app` to the tx app *before* `e.next()`, so the save joins that transaction and the response is deferred to commit. Then a failed audit write does what it should: rolls the change back and fails the request loudly, rather than a 200 with a silently missing entry.
- **Helpers must be `require`d inside each handler.** Goja runs every callback in a fresh executor, so top-level declarations in `main.pb.js` are invisible to them — the shared builder lives in [pocketbase/pb_hooks/lib/claim-audit.js](pocketbase/pb_hooks/lib/claim-audit.js), a plain `.js` (not `.pb.js`, which PocketBase would load as a hook file in its own right).
- `delta_gb` is signed and directly comparable to the `deltaGb` handed to `assertClaimDeltaAllowed`: create is `+amount`, delete is `−amount`, update is `after − before`.

Read it via `GET /next-api/garage/claim-audit` (admin-only; filters `userId`, `nodeId`, `claimId`, `action`, paged). Surfaced at `/admin/ledger` and inline in each expanded `(user, node)` row on `/admin/claims`.

#### Storage balances

`StorageNodeBalances` / `StorageUserBalances` are a **cache** of the two ledgers, so reading a position costs O(nodes) instead of O(ledger entries). The ledgers only grow; every per-user sum used to read one page of one, which is a silent wrong answer waiting on row count — and those sums backed `assertClaimDeltaAllowed`, the guard on every claim mutation.

**Why per `(user, node)` and not one net figure per user.** A claim on a node that has left the layout must count as zero, and a PocketBase hook cannot reach Garage to learn which nodes those are. Keeping the breakdown lets the layout filter stay where it can be applied correctly — at read time, in `computeSummaryFromBalances`. A hook-written `net_granted_gb` would silently keep counting decommissioned hardware. For the same reason `StorageUserBalances.claims_gb` is the *unfiltered* cross-node sum and must never be used as the grant; it exists to detect drift.

**Maintenance** — all writes go through [pocketbase/pb_hooks/lib/storage-balance.js](pocketbase/pb_hooks/lib/storage-balance.js):

- The claim hooks do double duty: audit row **and** balance update, in the same handler after the same `e.next()`, inside the same `withRecordTx` transaction. Splitting them would only create a way for them to disagree. Every balance-maintaining hook (claims, transfers, buckets, the `Users` cascade) is wrapped the same way — the read-modify-write in `applyClaimDelta` needs it twice over, since `StorageNodeBalances` has a `UNIQUE (user, node_id)` that two concurrent claims on the same pair would otherwise race.
- `StorageTransfers` (create/delete) and `Buckets` (create/update/delete) have their own hooks. The Buckets update hook skips rows where `quota_gb` didn't move — most Buckets writes are the usage-cache refresh on every dashboard load.
- **Cascades are the subtle part.** `StorageTransfers` cascades from *both* parties, so deleting a user silently removes transfers the counterparty is still owed — and no transfer hook fires. The `Users` delete hook unwinds the survivor's side inline; leaving it to the nightly rebuild would let them over-allocate in the meantime.
- **Backfill lives in the migration** ([1786122444_created_StorageUserBalances.js](pocketbase/pb_migrations/1786122444_created_StorageUserBalances.js)), *not* an `onBootstrap` hook. Migrations run **after** bootstrap fires, so a hook-based backfill finds no collections on exactly the upgrade boot that has data to backfill — verified the hard way. Don't move it.
- A nightly cron (`storage-balance-rebuild`) and `POST /next-api/garage/storage-balances/rebuild` (admin, proxied to a superuser-only PB route added with `routerAdd`) both call the same `rebuildAll`. One implementation on purpose: a second one in TypeScript could disagree with the hooks it is meant to be auditing.

A non-zero `corrected`/`last_drift_gb` from a rebuild is **a bug, not routine maintenance** — it means an incremental hook missed a write path. Node-level corrections are folded into the owning user's `last_drift_gb` so the affected user is identifiable.

`last_drift_gb` and the returned `driftGb` are the **worst single correction, signed** — not a net and not a sum. A net cancels (5 GB short on claims plus 5 GB over on allocated nets to zero and reports a doubly-wrong row as clean); a sum over-reports, because one missed `applyClaimDelta` leaves both the node row and the user row short by the same amount, so adding them states one discrepancy at twice its size. Every field is compared on its own, and the largest disagreement wins.

#### Cluster read cache

Loading `/dashboard` used to mean, per load: `GetClusterLayout` three times (invite pickup, storage-summary, cluster/nodes), a `GetClusterStatus` + `GetClusterStatistics` peer fan-out, `GetBucketInfo` once per bucket, and two uncached `_superusers.authWithPassword` bcrypts. None of it is realtime — a layout changes when an operator changes it — so the display paths now read through `GarageClusterCache`.

[webapp/src/lib/garage/cached.ts](webapp/src/lib/garage/cached.ts) is the whole implementation: `getCachedLayout` / `getCachedStatus` / `getCachedHealth` / `getCachedReplicationFactor`, all one private `readThroughCache`. Fresh row (within TTL — layout 60s, status/health 30s, replication factor 1h) returns with zero Garage calls; a stale row returns immediately and refreshes behind the response; a miss, or a payload the schema no longer accepts, blocks on Garage and writes through. **With Garage unreachable a stale row is served whatever its age** — there is no maximum staleness, because riding out an outage is the point; only a cold cache still errors.

Three things hold it together:

- **Validators never read it.** Claim mutations, transfer sends/returns, bucket quota validation, and invite settlement keep calling `cluster.getLayout` live. A stale layout must not decide whether capacity exists. This is the rule to check first when adding a handler.
- **`getPbAsSuperuser()` is memoized** ([auth/server.ts](webapp/src/lib/auth/server.ts)) — a module-level client plus an in-flight auth promise, so N parallel misses cost one bcrypt rather than N. The cache collection's rules are all `null`, so every read of it needs that client; without memoization the cache would have cost more than it saved.
- **Refreshes are deduped per key in-process** (a module-level `Map`), because one dashboard load fans out into three handlers that all want the layout. Cross-process races fall to `upsertByKey`'s unique-index catch: the loser re-reads and updates, and both writes are fresh.

Two more paths were reordered rather than cached. `POST /invites/claim` now takes the layout as a thunk, so the common "nothing pending" case costs one indexed PB read and no Garage call at all (it stays *live* when invites do exist — it writes transfers). And `GET /buckets` serves the `Buckets` usage columns it was already maintaining, calling `refreshBucketsFromGarageBackground` off the response path; it only blocks on Garage for buckets with no `usage_updated_at` at all, where there is nothing cached to serve and an imported bucket may hold real data. The refresh is deliberately ungated by any TTL — the daily `bucket-usage-alerts` cron depends on dashboard reads keeping those columns current.

Node-metrics paths are untouched and separate: the scrape runs inside the PB process via `$http.send`, and reads are PB-only.

#### Bucket quota drift

`Buckets.quota_gb` and Garage's `quotas.maxSize` are written by separate calls in `PATCH /next-api/garage/buckets/[id]` with no rollback, so a failure between them leaves the two disagreeing.

`describeQuotaDrift()` in [quota-sync.ts](webapp/src/lib/storage/quota-sync.ts) compares **both** axes. The object-count one had never been checked: absent an override, `maxObjects` derives from `GARAGE_AVG_OBJECT_SIZE_MB`, so changing that setting leaves every existing bucket on a stale cap with nothing to notice. `quotaHasDrifted()` stays deliberately size-only because it drives the automatic read-path self-heal — quietly rewriting a live object limit on a page load is not something a GET should do.

- `GET /next-api/garage/buckets/quota-audit` (admin) — every bucket with both sides, the drift flags, live usage, and the owner's email. A bucket whose Garage fetch fails is `status: 'unknown'`, never `ok`: not knowing is not the same as agreeing. It reads `getFullList`, so it is the *complete* list — the reason the quota page reads usage from here rather than joining against `/buckets?all=true`, which serves one 200-row page.
- `POST /next-api/garage/buckets/reconcile` (admin) — `direction: 'adopt-garage'` (default, the historical behaviour) or `'push-pb'`, which is what repairs a half-applied PATCH where adopting would discard the admin's actual change. Optional `includeObjects` and `bucketIds`.
- Surfaced on **`/admin/quota`**, grouped by user, with bulk reconcile behind the OTP gate and a per-bucket **Change quota** dialog behind a type-the-bucket-name challenge. `/admin/buckets` is a plain sortable inventory and carries none of this.

> **Neither gate is server-enforced.** `authWithOTP` runs in the browser and its only effect on app code is a React boolean; the name challenge is likewise just a React boolean. No route handler reads either, so a `curl` with an ordinary session token bypasses both — for bucket delete, key revoke, key create, permission toggles, and the admin quota override. They guard against a careless click, not a stolen session. Making the OTP real means sending `otpId` + code with the request and verifying server-side. Don't mistake the dialog for enforcement.
>
> The two gates answer different questions, which is why the quota dialog uses the challenge rather than the OTP: an OTP asks *is it still you*, a name challenge asks *did you mean this bucket*. Editing a quota on the wrong row is the failure an OTP does nothing about.

#### Object quotas

`Buckets.object_quota` is the authoritative object-count cap: **> 0 is an explicit admin override; 0 or unset means "derive from `GARAGE_AVG_OBJECT_SIZE_MB`"**, the historical behaviour. There is deliberately no way to say "explicitly uncapped" — Garage treats `maxObjects` 0 and null identically, so a stored 0 could never be distinguished from an absent override.

It exists because the object axis was previously *only* derived, so an admin could not set an object cap at all: any cap written straight to Garage would be reported as drift forever and reverted by the next bulk reconcile. `describeQuotaDrift` now measures Garage against the override when one is set, so a deliberate cap reads as clean.

- `effectiveMaxObjectsFor(record)` in [object-quota.ts](webapp/src/lib/storage/object-quota.ts) — "what should this bucket be capped at". **Every write of a `maxObjects` to Garage goes through it**, so a user resizing their own bucket never recomputes an admin's override away. `maxObjectsForQuotaGib(gib)` is the plain derivation, for the two places with no record to consult (bucket creation, and adopt-garage right after clearing an override).
- The arithmetic lives in [object-cap.ts](webapp/src/lib/storage/object-cap.ts), which is deliberately **not** `server-only` (like `units.ts` and `ledger-math.ts`): the admin quota dialog has to show the cap a bucket *would* derive as the size input changes, and a second hand-rolled copy in a component is how the two would come to disagree. Only the env read stays server-side.
- An object cap is **not** validated against the owner's storage claim. There is no object ledger and no per-user object grant — all four storage invariants are size-denominated — so `PATCH /buckets/[id]` deliberately skips the layout fetch and balance reads on an object-only edit.
- `adopt-garage` has two branches for this axis. When Garage enforces a cap, adopting records it into `object_quota` (the live limit does not move, only the disagreement). When Garage caps nothing, there is no PB value to adopt — `0` means "derive" — so it clears any stale override and writes Garage the derived cap instead.
- Garage's `quotas` object **replaces both axes** on every `UpdateBucket`, so an object-only edit must still re-send `maxSize`, or the size quota is silently dropped.

### Admin gate

Admin checks use the `Admins` collection rules: the listRule/viewRule (`@collection.Admins.user ?= @request.auth.id`) means a non-admin querying their own row gets a 404 and an admin gets the record. So [webapp/src/lib/auth/server.ts](webapp/src/lib/auth/server.ts) `isUserAdmin()` and the client-side [webapp/src/hooks/use-admin-status.ts](webapp/src/hooks/use-admin-status.ts) both work via the same self-scoped lookup, no superuser auth needed.

`getPbAsSuperuser()` from [webapp/src/lib/auth/server.ts](webapp/src/lib/auth/server.ts) authenticates as a PB superuser when a Route Handler needs to bypass collection rules (e.g. updating fields the caller's `updateRule` doesn't permit). After the migration that opened Users list/view to admins, most admin reads no longer need this — but it remains the escape hatch for trusted writes.

### Garage client

[webapp/src/lib/garage/](webapp/src/lib/garage/) wraps the [Garage admin API v2](https://garagehq.deuxfleurs.fr/api/garage-admin-v2.html). Every file starts with `import 'server-only'`. Every Garage response is parsed through a zod schema in [webapp/src/lib/garage/schemas.ts](webapp/src/lib/garage/schemas.ts) — Garage v2 is "early implementation, may change", so the schema layer protects us against drift. Errors map to typed classes (`GarageNotFoundError`, `GarageQuorumError`, `GarageAuthError`, `GarageValidationError`) in [errors.ts](webapp/src/lib/garage/errors.ts).

Tests for the client are in [webapp/src/lib/garage/garage-client.test.ts](webapp/src/lib/garage/garage-client.test.ts) — they mock `globalThis.fetch`. The vitest config aliases `server-only` to a stub ([webapp/src/test/server-only-stub.ts](webapp/src/test/server-only-stub.ts)) so server modules are importable from tests.

## Key invariants

- **Client-side PocketBase only.** Don't call PocketBase from a Server Component. Server-side PB instances exist only inside `/next-api/garage/*` Route Handlers — and only to verify the caller's auth token (`authRefresh`) or perform privileged admin operations as a superuser. Rationale: [docs/PB_SSR.md](docs/PB_SSR.md).
- **Garage client is server-only.** The bearer token must never reach the browser. Anything under `webapp/src/lib/garage/` is `import 'server-only'`. Browsers reach Garage exclusively via `/next-api/garage/*` proxies.
- **Mutators, not raw SDK** for PB reads. Data access goes through a `BaseMutator` subclass (see [shared/src/mutators/base.ts](shared/src/mutators/base.ts)) — handles zod validation, default expand/filter/sort, error wrapping, realtime subscriptions. Direct `pb.collection('...').create(...)` calls are a smell for read paths; mutations on `AccessKeys`/`Buckets` go through Route Handlers and may use the typed PB client directly there since the validation already happened above.
- **Mutators live in `shared/`**, exposed via `@garage-ware/shared/mutators`.
- **`TypedPocketBase` is duplicated.** [webapp/src/lib/types.ts](webapp/src/lib/types.ts) defines a webapp-local `TypedPocketBase` to avoid type drift between the webapp's `pocketbase` package and shared's. When wiring a new collection into the typed client, update **that** file's overload list, not just shared's.
- **Schema → migration → restart.** After editing a `defineCollection()` in `shared/src/schema/`: rebuild shared, run `yarn db:migrate`, review the generated file, then restart PocketBase (it auto-applies on startup).

## Adding a collection

1. Create `shared/src/schema/<name>.ts` using `defineCollection()` + zod field helpers from `pocketbase-zod-schema` (`TextField`, `RelationField`, `BoolField`, `NumberField`, etc.). Export the collection, the `Schema`, the `InputSchema`, and inferred types. See existing schemas (`user.ts`, `admin.ts`, `access-key.ts`, `bucket.ts`) for the pattern, or `storage-claim.ts` / `storage-transfer.ts` for an append-only ledger (deliberately non-unique index; transfers also set `updateRule: null`, since a handoff is corrected by deleting it, not editing it). `storage-claim-audit.ts` is the pattern for a hook-written, API-immutable log: all write rules `null`, `SelectField` for closed enums, and plain `TextField` in place of relations so rows outlive what they describe.
2. Re-export from [shared/src/schema.ts](shared/src/schema.ts).
3. Create `shared/src/mutators/<name>.ts` extending `BaseMutator<T, TInput>` — implement `getCollection()` and `validateInput()`. Re-export from [shared/src/mutators/index.ts](shared/src/mutators/index.ts).
4. Add a collection overload in [webapp/src/lib/types.ts](webapp/src/lib/types.ts).
5. `yarn workspace @garage-ware/shared build && yarn db:migrate`, review the migration, restart PocketBase.

### Migration ordering caveat

`pocketbase-migrate` emits one file per collection, timestamped at generation time. If a new collection's rule references another collection (e.g. `@collection.Admins.user ?= @request.auth.id`), the referenced collection must be created **first** — PocketBase validates rules at collection-save time and will reject a forward reference. After `yarn db:migrate`, check the generated filenames and rename them so timestamps order dependencies correctly. The current migrations show the pattern: `1778036285_created_Admins.js` runs before `1778036286_created_AccessKeys.js` and `1778036287_created_Buckets.js`.

**`yarn db:migrate` currently cannot generate at all.** The tool replays every prior migration in a plain JS sandbox to rebuild a snapshot, and [1786122444_created_StorageUserBalances.js](pocketbase/pb_migrations/1786122444_created_StorageUserBalances.js) calls `require` — a Goja global that only exists inside PocketBase. It fails with `ReferenceError: require is not defined` before reaching your schema change. Until that backfill is reworked, hand-write the migration following the shape of an existing one; [1786200000_updated_Buckets.js](pocketbase/pb_migrations/1786200000_updated_Buckets.js) (adding `object_quota`) is the worked example for a plain additive field, and notes why it sets `onlyInt`/`max` up front. [1786300000_created_StorageInvites.js](pocketbase/pb_migrations/1786300000_created_StorageInvites.js) is the worked example for a whole new collection — note the `pb_`-prefixed 15-character collection id, and the `select` / `date` / `autodate` field shapes the generator would otherwise have supplied. Verify by restarting PocketBase and reading the collection back from `/api/collections/<Name>`.

**Generated migrations are a starting point, not gospel.** Hand-editing one is normal when the generator can't express the change — [1785361304_updated_StorageClaims.js](pocketbase/pb_migrations/1785361304_updated_StorageClaims.js) (the append-only-ledger conversion) is the worked example: it splits one schema diff into ordered `app.save()` steps because the replacement index reuses the name `idx_storageclaims_user_node` and PocketBase rejects a collection holding two indexes with the same name, so the drop must land before the add. It also documents in its `down` that reverting can't succeed against existing ledger data without collapsing each `(user, node)` pair first. Read the generated file before trusting it, and leave that kind of note behind.

## Adding a /next-api/garage/* Route Handler

1. Create `webapp/src/app/next-api/garage/<...>/route.ts` exporting `GET`/`POST`/etc.
2. Start with `await getServerUser(req)` (any authenticated caller) or `await requireAdmin(req)` (admin-only). For ownership checks: load the PB row and compare `record.user !== user.id` then fall back to `isUserAdmin(pb, user.id)`. All three helpers are in [webapp/src/lib/auth/server.ts](webapp/src/lib/auth/server.ts).
3. Build a Garage client via `GarageClient.fromEnv()` and call the relevant module under `lib/garage/` (`cluster`, `keys`, `buckets`, `permissions`). Claim/transfer handlers touch no Garage state except the layout — they call `loadClaimContext(garage)` or `cluster.getLayout(garage)` purely to value capacity. **If the handler only displays cluster state, import `@/lib/garage/cached` instead** (`getCachedLayout` etc. — not exported from the `lib/garage` barrel, on purpose). If it validates anything, keep it live; see [Cluster read cache](#cluster-read-cache).
4. For mutations: write PB first, call Garage second; on Garage failure, roll back the PB row (and vice versa for deletes — Garage first, PB second). Use `try { ... } catch (err) { return errorResponse(err); }` to map `HttpError`/`GarageError` to JSON responses.
5. From the client, call via `api()` from [webapp/src/lib/api-client.ts](webapp/src/lib/api-client.ts) — it auto-attaches the PB token as a bearer header. Don't write a bare `fetch()`.

## Docker

[docker/Dockerfile](docker/Dockerfile) builds a single container with Supervisor running PocketBase + Next.js + Nginx (reverse proxy on :80). All runtime state lives under a single `/data` volume — back up by snapshotting that one directory. See [docker/README.md](docker/README.md). Garage itself runs separately; the container only needs to reach `GARAGE_ADMIN_URL` over the network.

Nginx routing inside the container:

| Path | Backend |
|---|---|
| `/` | Next.js :3000 |
| `/api/` | PocketBase :8090 (API) |
| `/_/` | PocketBase :8090 (admin UI) |
| `/health` | PocketBase health probe |

In Docker, build with `NEXT_PUBLIC_POCKETBASE_URL=/` (same-origin) — the PB JS SDK appends `/api/...` to the base URL itself, and nginx proxies that prefix through to PocketBase, so `/api` here would resolve to `/api/api/...`. That `/` is the Dockerfile default and what [docker-build.yml](.github/workflows/docker-build.yml) passes. For local dev, use `http://localhost:8090`.

## Notes

[docs/](docs/) is vendored upstream reference material, not docs about this app — `PB_*.md` for PocketBase (auth, hooks, crons, filters, realtime, SSR) and `GarageHQ_*` for the cluster, including the full [admin API OpenAPI spec](docs/GarageHQ_OPENAPI.json). Check there before guessing at a PB rule syntax or a Garage endpoint shape; the one file that *is* about this app's design is [docs/PB_SSR.md](docs/PB_SSR.md).

PocketBase's JSVM typings only exist at `pocketbase/pb_data/types.d.ts`, which the binary writes on first start — so hook signatures can't be checked until you've run PB once. `yarn setup && yarn workspace @garage-ware/pb dev` gets you the file; grep it before trusting any remembered hook API, since v0.23 reshaped all of them.

They reach the hook sources through [pocketbase/jsconfig.json](pocketbase/jsconfig.json), **not** a `/// <reference path=... />` line in each file, and re-adding one breaks the build: `pb_data/` is gitignored, `webapp/src/lib/metrics/node-metrics-lib.test.ts` imports `pb_hooks/lib/node-metrics.js` across the workspace boundary, and a dangling reference in a file the webapp's TS program loads fails `next build` with TS6053 on any checkout that has never run PocketBase — which is every CI run. `yarn check:refs` ([scripts/check-tracked-inputs.mjs](scripts/check-tracked-inputs.mjs), first step of `yarn precommit`) is the guard: it fails when a tracked file references or relatively imports a path git doesn't track. `pb_migrations/` is exempt — the generator writes that header itself, and nothing ever imports a migration.

ESLint config at the repo root ignores `pocketbase/**` and `scripts/**` ([eslint.config.mjs](eslint.config.mjs)). The lint rule `react-hooks/set-state-in-effect` is enabled and strict — define an inner async function inside `useEffect`, do all `setState` calls inside its async callbacks (with a `cancelled` flag) rather than in the effect body or in helpers called synchronously from it. See [webapp/src/app/dashboard/buckets/page.tsx](webapp/src/app/dashboard/buckets/page.tsx) for the canonical pattern.
