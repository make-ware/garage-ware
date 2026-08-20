# Architecture and design notes

The long-form companion to [CLAUDE.md](../CLAUDE.md). CLAUDE.md carries the rules
an agent must follow; this file carries the reasoning behind them — why each
boundary is where it is, what broke when it wasn't, and what must not be
"simplified" back. Read the section here before changing anything CLAUDE.md
marks as load-bearing.

## What this app is

`garage-ware` is the management/control plane for a self-hosted [Garage HQ](https://garagehq.deuxfleurs.fr/) S3-compatible storage cluster. Four features:

1. **Cluster administration** — admins view live cluster status/health/layout/nodes.
2. **Storage claims with replication factor** — admins grant users storage per cluster node as an append-only ledger of signed adjustments; a user's total claim is the sum of their entries, and they allocate slices of it as per-bucket quotas. Replication factor is read live from Garage's layout.
3. **Storage transfers** — a user (or an admin on their behalf) hands part of their *unallocated* claim to another user, found by email. Also append-only; "returning" a transfer means deleting the row. An address with no account yet gets a **StorageInvite** instead: the same handoff held in escrow, emailed to the recipient, and converted to a real transfer when they sign up — see [Storage invites](#storage-invites).
4. **Storage user self-service** — users manage their own S3 access keys, buckets, per-key bucket permissions, and live usage.
5. **Repairs** — admins launch Garage's per-node repair operations (scrub, block repair, rebalance) and read each node's scrub state. Administered at `/admin/repairs`; every launch appends to the cluster timeline. See [Repairs](#repairs).
6. **Cluster event timeline** — a dated log of what changed in the cluster and why. Layout changes, disk resizes and connectivity are detected by diffing consecutive metrics scrapes; causes are typed in by an admin. Administered at `/admin/events`; a reduced, redacted version renders below the node map on `/dashboard/cluster` for every signed-in user. See [Cluster events](#cluster-events).

The one formula to keep in your head — a user's **net granted GB**:

```
netGranted = sum(claims on nodes still in the layout) + sum(transfers received) − sum(transfers sent)
available  = netGranted − sum(bucket.quota_gb)              # what they may still allocate
```

Never hand-roll it. Server-side, read it from `getUserGrantedGb()` (a single number) or `getUserStorageSummary()` (the full position) — see [Storage accounting](#storage-accounting).

**Source-of-truth split.** Garage owns buckets, keys, layout, and usage data. PocketBase owns identity (Users, Admins), the Garage↔user mappings (`AccessKeys.user`, `Buckets.user`), and the two claim ledgers (StorageClaims, StorageTransfers) — which have no Garage counterpart at all, since Garage has no concept of a user. PocketBase intentionally does **not** duplicate Garage state — anything Garage knows authoritatively is proxied live, never mirrored. `NodeMetrics` is the deliberate second exception (after the `Buckets` usage cache): Garage only exposes *instantaneous* values, so a 15-minute history has no authoritative source to proxy — recording it is sampling, not mirroring. Deeper cluster metrics (throughput, request rates) still live in InfluxDB + Grafana, not here.

`ClusterEvents` is the fourth, and the furthest from a mirror of all of them: Garage keeps no history of *itself*. There is no event stream, no webhook and no attribution in the admin API, and `GetClusterLayoutHistory` returns per-version node *counts* with no timestamps and no role detail — so a layout change cannot be reconstructed after the fact, only noticed as it happens. A detected event is therefore not a copy of anything: it exists only because two consecutive samples disagreed and something wrote that down. See [Cluster events](#cluster-events).

`GarageClusterCache` is the third, and the only one that *is* a mirror: a stale-while-revalidate cache of the layout, status, health, and replication factor, holding the raw response body under a unique `key` with the timestamp Garage answered. It exists because every dashboard load re-fetched the layout three times over plus a cluster-wide status fan-out, none of which is realtime data. It is written and read only by the Next.js handlers through [webapp/src/lib/garage/cached.ts](../webapp/src/lib/garage/cached.ts) — no hook, no cron, all five collection rules `null`, superuser-only (a raw layout carries node addresses the browser is never handed). **Display paths only.** Every storage invariant is enforced against the layout, so claim mutations, transfer sends and returns, bucket quota validation, and invite settlement all keep fetching live: being a minute out of date is harmless for showing a number and unsafe for checking one. Payloads are re-parsed through the zod schemas in `lib/garage/schemas.ts` on every read, and a payload that no longer parses counts as a miss — Garage v2 may still change shape.

The one narrow exception: `Buckets.bytes`, `Buckets.objects`, `Buckets.max_size`, `Buckets.max_objects`, and `Buckets.usage_updated_at` are a cache, refreshed by the webapp's `/next-api/garage/buckets/*` handlers when a user views the dashboard — since [Cluster read cache](#cluster-read-cache), *behind* the response rather than before it, and also **read** by `GET /buckets` instead of only written — and consumed by the daily `bucket-usage-alerts` cron in [pocketbase/pb_hooks/main.pb.js](../pocketbase/pb_hooks/main.pb.js). The cron is intentionally DB-only (no Garage call); stale data is acceptable because the alert nudges users back to the dashboard, which refreshes the cache. (These mirror Garage's reported usage and quotas in raw Garage units: `max_size`/`max_objects` are the byte/object caps Garage currently enforces. `quota_gb` stays the authoritative size quota and drives the cron's byte-fill check; `max_size` is the convenience byte mirror, while `max_objects` lets the cron alert on object-count fill. Don't confuse `max_objects` — a mirror of what Garage enforces — with `object_quota`, which is the authoritative override for what it *should* enforce.)

## Workspace layout

Yarn v4 monorepo (`packageManager: "yarn@4.12.0"`) with three workspaces:

- `webapp/` (`@garage-ware/webapp`) — Next.js 16 + React 19 + Tailwind v4 + shadcn/ui frontend. Mostly client-side; server-side code is confined to `webapp/src/app/next-api/*` (Route Handlers) and the `import 'server-only'` libraries they call — `webapp/src/lib/garage/`, `lib/auth/server.ts`, and most of `lib/storage/`.
- `shared/` (`@garage-ware/shared`) — ESM TypeScript package: zod schemas, collection definitions, mutators, types, error utilities. Built with tsup. Subpath exports: `./schema`, `./mutators`, `./mutator`, `./types`, `./enums` — see [shared/package.json](../shared/package.json).
- `pocketbase/` (`@garage-ware/pb`) — PocketBase binary, hooks ([pocketbase/pb_hooks/main.pb.js](../pocketbase/pb_hooks/main.pb.js)), migrations ([pocketbase/pb_migrations/](../pocketbase/pb_migrations/)), and the [seed-admin script](../pocketbase/scripts/seed-admin.mjs). The folder is `pocketbase/` for local-dev clarity; the production Docker image keeps the in-image path at `/app/pb/`.

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
yarn workspace @garage-ware/pb admin <email> <password>

# Promote an existing user to app-admin (needs POCKETBASE_ADMIN_EMAIL/PASSWORD;
# falls back to webapp/.env, like the pb `dev` script). The user must already exist.
yarn workspace @garage-ware/pb seed-admin <user-email>
```

CI ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) runs: `yarn install --immutable` → `build` → `format:check` → `lint:check` → `typecheck` → `test`. Match this order locally before pushing.

## Repo location and release pipeline

The canonical remote is **`github.com/make-ware/garage-ware`** (private; moved from `dastron/garage-ware`). Container images publish to **two public registries from one build**: **`dastron/garage-ware`** on Docker Hub — the public install path, what [docker-compose.yml](../docker-compose.yml) and the READMEs point at — and **`ghcr.io/make-ware/garage-ware`** on GHCR, for development. Both carry the same digests.

Three workflows, none of which hardcode the owner — the image name comes from `${{ github.repository }}` and auth from the built-in `GITHUB_TOKEN`, so another move needs no workflow edits:

| Workflow | Trigger | Does |
|---|---|---|
| [ci.yml](../.github/workflows/ci.yml) | push/PR on `main` | the quality gate above |
| [release-please.yml](../.github/workflows/release-please.yml) | push on `main` | maintains a release PR (bumps [package.json](../package.json) + [.release-please-manifest.json](../.release-please-manifest.json), writes [CHANGELOG.md](../CHANGELOG.md)); on merge tags `vX.Y.Z`, cuts a release, then calls docker-build |
| [docker-build.yml](../.github/workflows/docker-build.yml) | `workflow_call` from release-please, a `v*.*.*` tag push, a published release, or manual dispatch | builds `linux/amd64` + `linux/arm64` in parallel, pushes by digest, then merges one multi-arch manifest tagged `vX.Y.Z` + `latest` — to GHCR always, and to Docker Hub when configured |

Notes when touching these:

- **Conventional commits are load-bearing.** release-please derives the version bump and changelog from `feat:` / `fix:` / `feat!:` prefixes. A non-conventional commit message produces no release entry.
- **Version lives in three places** — [package.json](../package.json), [.release-please-manifest.json](../.release-please-manifest.json), and the `v*` git tag. release-please owns all three; never bump by hand.
- **`org.opencontainers.image.source`** is set on both the per-arch images and the merged manifest. That label is what links the GHCR package to this repo (and so makes the package inherit repo access) — keep it if you rewrite the labels block.
- **The repo is private; both packages are public.** Package visibility is set on the package, not inherited from the repo, so neither registry needs a login to pull — do not reintroduce the `read:packages` PAT instructions that used to be in the READMEs.
- **The Docker Hub name is the one hardcoded identifier in these workflows, and it has to be.** `DOCKERHUB_IMAGE: docker.io/dastron/garage-ware` cannot be derived from `${{ github.repository }}` the way the GHCR name is — a Docker Hub namespace is a separate account that does not follow the git repo if it moves. Credentials come from the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets. The consequence to know: a fork inherits a push to a namespace it has no token for, so moving or forking needs that one line edited, unlike everything else here.
- **One build, two registries — never two builds.** The build job pushes each per-arch image **by digest to both names at once** (`outputs: type=image,"name=ghcr…,docker.io/…",push-by-digest=true`; the inner quotes are load-bearing, since buildx parses that string as CSV and the comma between the two names would otherwise split the field). The merge job then runs `imagetools create` once per registry over the *same* digests. So the two registries serve identical digests rather than two independently-built images that happen to share a tag, and Docker Hub costs no extra build minutes. Do not "simplify" this into a second matrix build.
- **`release-please.yml` passes `secrets: inherit`.** A called workflow sees no secrets at all unless the caller passes them, so without it the Docker Hub login would fail on exactly the trigger that matters — the release — while working fine on a manual dispatch. `GITHUB_TOKEN` is available either way, which is why the omission was invisible until now.
- Tags and releases that release-please itself creates do **not** re-trigger workflows (`GITHUB_TOKEN`-authored events never do) — that's why release-please invokes docker-build via `workflow_call` rather than relying on the tag-push trigger. The `push: tags` / `release: published` triggers are for human-created tags and releases.

## Required env vars

See [.env.example](../.env.example) — [webapp/.env.example](../webapp/.env.example) is a byte-identical copy, so edit both or neither. The split matters:

- `NEXT_PUBLIC_POCKETBASE_URL` — browser-visible; the webapp's PB client uses this.
- `POCKETBASE_URL` / `POCKETBASE_ADMIN_EMAIL` / `POCKETBASE_ADMIN_PASSWORD` — server-only; used by the migration tool, the `seed-admin` script, and the `getPbAsSuperuser()` helper for trusted admin operations. The email and password are **required** by [shared/pocketbase-migrate.config.js](../shared/pocketbase-migrate.config.js), which throws a named error rather than falling back to a default credential.
- `GARAGE_ADMIN_URL` / `GARAGE_ADMIN_TOKEN` — **server-only**; consumed by [webapp/src/lib/garage/](../webapp/src/lib/garage/) **and** (via `$os.getenv`) by the PocketBase `node-metrics-scrape` cron, so the PB process must see them too — the pb workspace `dev` script sources `../webapp/.env` for exactly this reason, and in Docker they arrive via `docker run -e`. The cron warns-and-skips when they are unset. The bearer token must never appear in any `NEXT_PUBLIC_*` var or anywhere a client bundle could see it.
- `GARAGE_S3_ENDPOINT` / `GARAGE_S3_REGION` — the S3 gateway URL (**required, no default** — an unset value makes `/next-api/config` return a 500 rather than silently falling back to some other cluster's gateway) and region (default `us-east-1`) used by the in-app file browser ([webapp/src/lib/s3/browser.ts](../webapp/src/lib/s3/browser.ts)) and the bucket "connect" page. These are **non-secret public values** but are intentionally **runtime** server-side env (no `NEXT_PUBLIC_` prefix), served to the browser at request time by the [`/next-api/config`](../webapp/src/app/next-api/config/route.ts) route and fetched client-side via [webapp/src/lib/s3/config.ts](../webapp/src/lib/s3/config.ts) (`useS3Config()`). The point is deployability: a `NEXT_PUBLIC_*` var is inlined into the client bundle at build time, so one image could only ever target one gateway; reading them at runtime lets the same image be pointed at any cluster via plain env (e.g. a k8s pod `env:`) with no rebuild. The file browser still runs **entirely client-side**: it signs S3 requests in the browser with **user-supplied credentials** (the secret is typed into the credential gate, kept only in `sessionStorage` for the tab, and never sent to our server or persisted by PB) — no token lives in env, only the endpoint + region. Because the browser talks to the gateway directly, **each bucket must allow CORS** from the app's origin (methods GET/PUT/HEAD, the `authorization`/`x-amz-*`/`content-type` request headers, `ETag` exposed) or the browser blocks the requests.
- `GARAGE_AVG_OBJECT_SIZE_MB` — **optional, server-only**. Average object size in MB. When set, the `/next-api/garage/buckets` handlers derive each bucket's Garage `maxObjects` quota from its byte quota (`maxObjects = floor(quota_bytes / (this × 1MB))`, at least 1) whenever a quota is created or changed; the bucket details page surfaces the resulting object cap, and the daily `bucket-usage-alerts` cron emails when a bucket's object-count fill crosses the user's threshold (it reads the cached `Buckets.objects`/`Buckets.max_objects`). Leave unset to apply no object-count cap (`maxObjects` stays `null`). Read at request time via `process.env` (see [webapp/src/lib/storage/object-quota.ts](../webapp/src/lib/storage/object-quota.ts)). **The derivation is only the default** — a bucket carrying an `object_quota` override ignores this value entirely; see [Object quotas](#object-quotas).
- `GARAGE_PUBLIC_S3_ENDPOINT` — **optional, server-only**. The endpoint *advertised to users* on the bucket "connect" page for their own tools (aws cli, rclone). Served as `s3PublicEndpoint` by [`/next-api/config`](../webapp/src/app/next-api/config/route.ts) and falls back to `GARAGE_S3_ENDPOINT`. Set it when the URL you publish differs from the CORS-enabled gateway the in-app file browser must talk to — the browser always uses `GARAGE_S3_ENDPOINT`.
- `APP_PUBLIC_URL` — server-only, read via `$os.getenv` by the PocketBase `bucket-usage-alerts` cron **and** the `StorageInvites` create hook, to build absolute CTA links in emails. Must reach the PB process (in Docker, pass via `docker run -e`). Unset and each logs a warning and skips — for invites that means the row is still written and visible to the sender, but nobody is told.
- `GARAGE_COST_USD_PER_TB` / `GARAGE_HARDWARE_LIFESPAN_YEARS` — **optional, server-only** (defaults `22` and `5`), read at request time by [webapp/src/lib/pricing/config.ts](../webapp/src/lib/pricing/config.ts) and served to the browser by [`/next-api/config/pricing`](../webapp/src/app/next-api/config/pricing/route.ts). They drive the dashboard's cost-comparison card. **`GARAGE_COST_USD_PER_TB` is the one-time cost of one TB of *raw disk*** — what the drive cost, a number an operator reads off an invoice. The cluster's **replication factor is applied on top, in code, from the live layout**, so at RF 3 a usable terabyte costs three times this. That split is deliberate: the operator configures what they paid, the cluster's own topology supplies the rest, and changing the replication factor moves the figure automatically. Non-numeric or non-positive values fall back to the defaults — notably `0`, which would otherwise render the cluster as free and the saving as infinite. The route deliberately does **not** return an effective $/GB/month, since that needs the replication factor the browser already holds from `/cluster/nodes`. See [Storage cost card](#storage-cost-card).
- `NODE_METRICS_RETENTION_DAYS` — **optional, server-only**, read via `$os.getenv` by the `node-metrics-scrape` cron: days of `NodeMetrics` history to keep (older rows are pruned each run). Default 90; `0` keeps everything. It does **not** touch `ClusterEvents`, which is never pruned — the timeline is meant to outlast the samples it explains.
- `FEATURE_NODE_CLAIMS` / `FEATURE_ASSET_CLAIMS` — **optional, Next.js-process-only, default OFF**; only `true`/`1` (parsed by [webapp/src/lib/setup/features.ts](../webapp/src/lib/setup/features.ts), fails closed) enables. `FEATURE_NODE_CLAIMS` gates exactly one thing: a user **self-claiming** a node by its full node id, and the self-release that undoes it ([Node ownership](#node-ownership)); off = only an administrator creates or removes an ownership row, on `/admin/nodes`. Everything else runs regardless — an assigned owner grants storage sourced from their node, `/dashboard/nodes` is reachable by every signed-in user, and `assertNodeOwner` reads no flag at all. `FEATURE_ASSET_CLAIMS` gates user self-claiming of existing keys/buckets ([Claiming existing keys and buckets](#claiming-existing-keys-and-buckets)); off = the admin import routes are the only onboarding path. Served to the browser by [`/next-api/config/features`](../webapp/src/app/next-api/config/features/route.ts) (a sibling of `/next-api/config`, so it inherits none of that route's 500-on-missing-endpoint behaviour) and read client-side via `useFeatures()` in [use-features.ts](../webapp/src/lib/setup/use-features.ts), which seeds all-off so a failed fetch hides gated UI rather than flashing it. The routes enforce the flags regardless of what the UI shows.

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

- **PocketBase** is reached directly from the browser using the JS SDK ([webapp/src/lib/pocketbase.ts](../webapp/src/lib/pocketbase.ts)). All consumer files use `'use client'`. PB's collection rules enforce per-user access. Rationale: [docs/PB_SSR.md](../docs/PB_SSR.md).
- **Garage admin API** is server-side only, proxied through Next.js Route Handlers under [webapp/src/app/next-api/garage/](../webapp/src/app/next-api/garage/). The handler reads the PB auth token from the `Authorization: Bearer <token>` header (sent by [webapp/src/lib/api-client.ts](../webapp/src/lib/api-client.ts)), verifies it via `pb.collection('Users').authRefresh()`, authorizes (admin via Admins collection, ownership via `AccessKeys.user`/`Buckets.user`), and only then calls Garage with the cluster bearer token.

### Data model

| Collection | Fields | Role |
|---|---|---|
| `Users` (PB auth) | `notification_threshold_pct` | Identity + per-account fill-alert threshold (10–99, integer, default 95). No storage field — the user's claim is derived from the two ledgers below. |
| `Admins` | `user: relation(Users)` | Membership grants the admin scope. Listed/viewed only by admins (the rule self-references `@collection.Admins`). |
| `AccessKeys` | `user`, `garage_key_id`, `name` | Maps a Garage S3 access-key ID to a PB user. Secret is shown once at creation, **never persisted and no longer readable back** — it is the credential `POST /keys/claim` accepts. Reads self-or-admin; **all three write rules `null`**, so the Route-Handler funnel is enforcement here. `garage_key_id` is UNIQUE and is the claim concurrency control. There is no `expired` column — expiry is Garage state, joined on at read time. See [Claiming existing keys and buckets](#claiming-existing-keys-and-buckets) and [Deleting and retiring](#deleting-and-retiring). |
| `Buckets` | `user`, `garage_bucket_id`, `name`, `quota_gb`, `object_quota`, `bytes`, `objects`, `max_size`, `max_objects`, `usage_updated_at` | Maps a Garage bucket to its owning PB user; `quota_gb` is mirrored to Garage's per-bucket quota and slices the user's total claim. `object_quota` (count, 0/unset = derive) is the **authoritative** object-cap override — see [Object quotas](#object-quotas). `bytes`/`objects`/`max_size`/`max_objects`/`usage_updated_at` are a usage cache refreshed on dashboard reads, consumed by the daily alert cron. `max_size` (bytes) mirrors `quota_gb`; `max_objects` (count, 0 = no cap) mirrors the `maxObjects` Garage currently enforces — a cache, **not** the intent. Reads self-or-admin; **all three write rules `null`**. Both `garage_bucket_id` and `name` are UNIQUE, and a claim reports them apart. See [Claiming existing keys and buckets](#claiming-existing-keys-and-buckets). |
| `StorageClaims` | `user`, `node_id`, `node_hostname`, `node_zone`, `quota_gb`, `note` | **Append-only ledger** of per-node grants, written by an admin **or by the owner of the node it is sourced from** (see [Node ownership](#node-ownership)). All three write rules are `null`; every mutation goes through `/next-api/garage/claims` as a superuser. One row is one signed adjustment (`quota_gb` may be negative to reclaim), not a state snapshot — a user's effective claim on a node is the sum of their rows for it, and their total claim is the sum across all nodes. `note` records why (e.g. "upgraded to 8TB disk"). `(user, node_id)` is indexed but deliberately **not unique**. |
| `StorageTransfers` | `from_user`, `to_user`, `quota_gb`, `note` | **Append-only ledger** of user→user handoffs of already-granted capacity. `quota_gb` is always positive (min 0.001) and flows `from_user → to_user`; there is no update path, and deleting a row is how a recipient "returns" it. Node-agnostic by design — a transfer carries no `node_id`. |
| `StorageInvites` | `from_user`, `to_email`, `quota_gb`, `note`, `status`, `settled_at`, `transfer_id`, `failure_reason` | A transfer whose recipient has no account yet. `to_email` is a **`TextField`, not a relation** — the row exists precisely because the user does not — stored lowercased so the claim lookup is a plain equality match. `status` is `pending` \| `claimed` \| `failed`; cancelling is a delete, as with transfers. **An invite promises, it does not reserve** — see [Storage invites](#storage-invites). |
| `NodeOwners` | `user`, `node_id`, `note` | **Who may grant storage sourced from which node.** One owner per node, enforced by a `UNIQUE` index on `node_id` — which is the concurrency control, not decoration, and the reason the claim route needs no mutex. Reads are self-or-admin, which is what lets `assertNodeOwner` resolve ownership through the *caller's own* client; all three write rules are `null`. `node_id` is a **`TextField`, not a relation**, as everywhere else nodes appear, and holds the node **key** — the full id the claimer supplied is checked against the live layout and discarded, never stored. Carries no hostname/zone snapshot on purpose — names resolve at display time. See [Node ownership](#node-ownership). |
| `StorageClaimAudit` | `action`, `claim_id`, `user_id`, `user_email`, `node_id`, `node_hostname`, `node_zone`, `previous_gb`, `new_gb`, `delta_gb`, `note`, `actor_id`, `actor_email`, `actor_type`, `source` | **Immutable audit trail** of every mutation to `StorageClaims`, written by the hooks in [pocketbase/pb_hooks/main.pb.js](../pocketbase/pb_hooks/main.pb.js). Admin-readable; all three write rules are `null`, since the hooks write through the Go/JSVM layer, which bypasses collection rules. Every reference is a **`TextField`, not a relation** — `StorageClaims.user` cascades from Users, so a relation would erase the trail exactly when it matters; `claim_id` is expected to dangle after its entry is deleted. See [Claim audit trail](#claim-audit-trail). |
| `StorageNodeBalances` | `user`, `node_id`, `claimed_gb`, `entry_count`, `node_hostname`, `node_zone`, `recomputed_at` | **Materialized roll-up** of the claim ledger, one row per `(user, node)`. A cache, hook-maintained. Unlike the audit collection, `user` **cascades** and `(user, node_id)` **is unique** — this is derived data, and letting the DB enforce one row per pair turns a hook bug into a loud error. See [Storage balances](#storage-balances). |
| `StorageUserBalances` | `user`, `claims_gb`, `sent_gb`, `received_gb`, `allocated_gb`, `recomputed_at`, `last_drift_gb` | Node-agnostic half of the same cache: transfers in/out and what the user's buckets reserve. `claims_gb` is the **unfiltered** cross-node sum and is *not* the granted figure — see the warning in [Storage balances](#storage-balances). |
| `NodeMetrics` | `node_id`, `node_hostname`, `node_zone`, `is_up`, `node_stats_ok`, `resync_queue_length`, `resync_errored_blocks`, `rc_entries`, `layout_ok`, `stored_partitions`, `partition_size_bytes`, `role_ok`, `role_capacity_bytes`, `node_tags`, `layout_version`, `garage_version`, `data_total_bytes`, `data_available_bytes`, `meta_total_bytes`, `meta_available_bytes` | **Per-node time-series**, one row per node per 15-minute `node-metrics-scrape` cron tick (sample time = autodate `created`; retention via `NODE_METRICS_RETENTION_DAYS`). Admin-readable, all write rules `null` (the cron writes via the JSVM). Node identity is a **`TextField`, not a relation** — nodes aren't PB entities — and holds the node **key**, not a full node id; see [Node identity](#node-identity) for why that is what keeps the open listRule below safe. PB number fields can't hold null, so "no reading" is encoded by three separate conventions: `node_stats_ok` gates the two resync fields **and `rc_entries`** (one `GetNodeStatistics` call, one gate); `layout_ok` gates `stored_partitions` / `partition_size_bytes` (one `GetClusterLayout` call); `role_ok` gates `role_capacity_bytes` / `node_tags` / `layout_version`; and `*_total_bytes = 0` means "no partition data" (gateway node). The bucketed history route emits real JSON `null`s for all of them. **Under `layout_ok`, `stored_partitions = 0` is a real reading** — "holds no partitions", i.e. a gateway or a node draining out of an older layout — which is the entire reason that gate exists: without it a failed layout call would record every node as a gateway and bake a permanent all-clear into the history. `role_ok` carries a **second** job on top of the same one: it also means "this row was written by a scraper that records the role columns", so pre-migration rows read `false` and the event detector refuses to diff against them — see [Cluster events](#cluster-events). The last five columns exist only for that detector; nothing charts them, and `bucketHistory` does not aggregate them. See [Node data coverage](#node-data-coverage). Readable by **any signed-in user** (list/view `@request.auth.id != ''`) — cluster health is visible without exposing who stores what, and since the rows carry keys there is no node credential in them to expose either: the cluster map reads each node's latest row straight from PB, while `GET /next-api/garage/node-metrics` stays the door for *history*, since the bucketing must run server-side. Recording a sample (`POST .../node-metrics/scrape`) stays admin-only. |
| `GarageClusterCache` | `key`, `payload`, `fetched_at` | **Stale-while-revalidate cache** of the Garage cluster reads, one row per `key` (`layout` \| `status` \| `health` \| `replication_factor`, unique index). `payload` is the raw response body (the repo's only `JSONField`; `replication_factor` stores `{ replicationFactor: n }` so every payload is an object) and is re-parsed through `lib/garage/schemas.ts` on read — a payload that no longer parses is a miss. `fetched_at` is when Garage answered, **not** the autodate `updated`, which moves on any write. **All five rules `null`**, superuser-only, no hook and no cron: [webapp/src/lib/garage/cached.ts](../webapp/src/lib/garage/cached.ts) is the only reader and writer. See [Cluster read cache](#cluster-read-cache). |
| `ClusterEvents` | `kind`, `source`, `severity`, `node_id`, `node_hostname`, `node_zone`, `title`, `detail`, `previous_value`, `new_value`, `category`, `occurred_at`, `ended_at`, `annotation`, `annotated_by`, `annotated_at`, `actor_id`, `actor_email` | **The cluster timeline.** One collection, three authors: `source: 'detector'` rows are appended by the `node-metrics-scrape` cron when two consecutive samples disagree, `source: 'manual'` rows are written by an admin, and `source: 'action'` rows are written by route handlers recording that a human pressed a button — `kind: 'repair'` from `POST /next-api/garage/repairs` (see [Repairs](#repairs)) and `kind: 'node_owner_changed'` from `/next-api/garage/nodes/owners` (see [Node ownership](#node-ownership)). Both go through `writeTimelineActionRow()` in [webapp/src/lib/cluster/timeline-write.ts](../webapp/src/lib/cluster/timeline-write.ts), which **never throws**: every caller has already changed the cluster or the database by the time it runs, so failing the request would report an action as not having happened and invite the operator to repeat it — callers surface `logged: false` instead. Admin-readable; **all three write rules `null`** (the cron writes via the JSVM, the route handlers as a superuser), so it is genuinely append-only from a browser. Node identity is a **`TextField`, not a relation**: a `node_removed` row must outlive its node. `previous_value` / `new_value` hold the **raw** value as text, never a rendered one — the UI formats by `kind`. Sorted and indexed on `occurred_at`, not `created`, so a note written today about last Tuesday lands on last Tuesday. `ended_at` empty means still open, and an open **manual** row pinned to a node is what marks it **under repair** — which is exactly why a repair launch is `action` and not `manual`, and why it closes itself (`ended_at = occurred_at`). **Nothing prunes it** — the point is to remember further back than the `NodeMetrics` it explains. **Two read doors:** `/next-api/garage/events` hands an admin the whole row, `/next-api/garage/cluster/events` hands any signed-in user a projection with the actor identity and the free-text fields stripped. The rules themselves stay admin-only, so that projection — not the rule — is the boundary. See [Cluster events](#cluster-events). |

**PB write rules are mostly not `null` — for those, the Route-Handler funnel is convention, not enforcement.** `StorageTransfers` lets the sender create and the recipient delete, so PB would happily *accept* a direct SDK write from the browser and every invariant behind that route would be skipped. All app writes go through `/next-api/garage/*`; keep it that way, and don't read the permissive rules as license to write from a component.

**`AccessKeys` and `Buckets` used to be in that list and no longer are.** All six of their write rules are `null` ([1787600000_lock_asset_write_rules.js](../pocketbase/pb_migrations/1787600000_lock_asset_write_rules.js)); reads stay self-or-admin, which is what keeps `loadOwnedKey`/`loadOwnedBucket` resolving ownership through the caller's own client. This was not tidying. Once a key or bucket became something a user can **claim** by proving a credential ([Claiming existing keys and buckets](#claiming-existing-keys-and-buckets)), the permissive rule made the proof decorative: any signed-in user could `pb.collection('AccessKeys').create({ user: self, garage_key_id: <somebody else's> })` from the browser and own it. Verified by hand against a copy of a real database — the same request answers 200 with the old rule and 403 with the new one.

**`StorageClaims` is the exception, and is genuinely enforced.** Its three write rules were `@collection.Admins.user ?= @request.auth.id` until node ownership needed a non-admin writer; they are now all `null` ([1787200000_updated_StorageClaims.js](../pocketbase/pb_migrations/1787200000_updated_StorageClaims.js)), so the only door is `/next-api/garage/claims` authenticating as a superuser. That was not a side effect — an admin could previously append a ledger entry straight from the browser SDK and skip every invariant, and once one write path had to be a superuser, leaving a weaker one open to browsers bought nothing. Superusers still bypass rules, so the PocketBase admin UI keeps working and is audited as `superuser`.

For `AccessKeys`/`Buckets`, a handler writes PB first, calls Garage, and rolls back the PB row on Garage failure (Garage first, PB second for deletes). `StorageClaims`/`StorageTransfers` have no Garage counterpart, so their handlers are pure PB writes fronted by a validator.

#### Storage accounting

**One formula, one implementation.** `computeStorageSummary()` in [webapp/src/lib/storage/ledger-math.ts](../webapp/src/lib/storage/ledger-math.ts) is the only place the net-granted arithmetic exists. That module is deliberately the *second* file under `lib/storage/` without `import 'server-only'` (alongside `units.ts`), because the admin console and the dashboard need the same roll-ups client-side — and when they each hand-rolled their own, they disagreed about whether a claim on a decommissioned node counts. It does not. Anything that sums a ledger, values a node, or rolls entries up per node belongs here, not in a component:

- `computeStorageSummary(claims, sent, received, allocatedGb, layout?)` — the whole position.
- `rollUpClaimsByUserNode` / `rollUpClaimsByNode` — signed entries collapsed per pair or per node, newest-first history included, plus a `presentInLayout` flag.
- `nodeUsableGbFrom(capacityBytes, rf)` / `nodeUsableGbInLayout(layout, nodeId, rf)` — `capacity / replicationFactor`.
- `filterPresentClaims`, `presentNodeIdSet`, `sumClaimsByNode`, `sumClaimsByUserNode`, `sumTransfers`, `userNodeKey`.

- `computeSummaryFromBalances(nodeBalances, userBalance, layout?)` — the same position from the materialized roll-ups. **It must always agree with `computeStorageSummary`**; that equivalence is asserted directly in [ledger-math.test.ts](../webapp/src/lib/storage/ledger-math.test.ts) and is what makes the cache safe to read.

Three server-side helpers wrap it with the fetching. All of them read the **balances**, not the ledgers, and all three live in [webapp/src/lib/storage/summary.ts](../webapp/src/lib/storage/summary.ts):

- `getUserPosition(pb, userId, layout?)` — **the call a guard reaches for.** One user's position in one query, without the transfer rows. Every check of the per-user invariant needs both halves of `sum(quota_gb) ≤ netGranted`, and taking them from a single read is what makes them provably consistent. Passing a `layout` values claims on nodes missing from it at zero, so decommissioned hardware can't back a bucket; transfers are never filtered, since they aren't node-scoped. It never reads another user's rows, so it needs no superuser client — the caller's own suffices whenever they are the subject or an admin.
- `getUserStorageSummary(pb, userId, layout?)` — `getUserPosition` plus two queries for the individual handoffs. The whole position in one object (`claimsGb`, `sentGb`, `receivedGb`, `netGrantedGb`, `allocatedGb`, `availableGb`, plus `nodeClaims` and the transfer rows). This is the read path for the dashboard and admin views.
- `getStorageSummariesForUsers(pb, userIds, layout?)` — same summary for many users, in 2 queries regardless of user count. Backs `GET /next-api/garage/users`. Use it for any list view; the per-user helper in a loop is both slow and, historically, how the admin list drifted. It returns no transfer *rows* — a list view wants totals.

The fetching lives in [webapp/src/lib/storage/balances.ts](../webapp/src/lib/storage/balances.ts) (`getUserBalances`, `getNodeClaimedGb`, `getUserNodeClaimedGb`, `getAllBalances`).

The old per-row aggregates on the mutators — `StorageClaimMutator.sumByUser/sumByNode/sumByUserAndNode`, `StorageTransferMutator.sumSentByUser/sumReceivedByUser`, `BucketMutator.sumAllocatedGb` — still exist but **nothing in the accounting path uses them any more**, because each reads a single page (200–1000 rows) of a collection that only grows. Don't reach for them in a new guard; read a balance instead.

That sentence used to be aspirational — **six** guards still paired `getUserGrantedGb` with `BucketMutator.sumAllocatedGb`, one query each, the second capped at a single 1000-row page: `POST /buckets` and `/buckets/import` and `/buckets/claim`, `PATCH /buckets/[id]`, `DELETE /transfers/[id]`, and `syncQuotaToPb`'s `adoptionFitsOwner`. All six now call `getUserPosition` once. `getUserGrantedGb` is **gone** along with `lib/storage/claims.ts`: it returned exactly `getUserPosition(...).netGrantedGb`, and leaving a second way to ask for one half of an inequality is how the two halves came to be fetched from different places to begin with.

Two of those six are editing a bucket that already counts toward the total, and that is the one piece of arithmetic they must not hand-roll. `StorageUserBalances.allocated_gb` is the owner's **whole** allocation, this bucket included, and a quota edit *replaces* that bucket's share rather than adding to it — so `allocatedExcluding(allocatedGb, bucket.quota_gb)` in [ledger-math.ts](../webapp/src/lib/storage/ledger-math.ts) takes it back out first, clamped at zero so a drifted balance cannot manufacture headroom. Omit it and every increase on a user's largest bucket is refused, including a no-op re-save of one that already fits.

From the browser, don't reassemble a user's position out of PB reads: `GET /next-api/garage/storage-summary` returns `getUserStorageSummary()` for the caller, or for `?userId=` when the caller is an admin. Same `?userId=`-or-self, admin-gated shape is used by `/next-api/garage/transfers`. `GET /next-api/garage/users` (admin) returns each user's full position as `net_granted_gb` / `allocated_gb` / `available_gb` — **not** a raw claim sum. Because it needs the layout to value claims, it reads the cached layout, the same way `/storage-summary` does — so with Garage unreachable both serve the last one seen rather than failing, and only a cold cache (nothing ever stored) still errors. Riding out an outage on a layout that changes when an operator changes it is the point; the invariant checks that must not be a minute behind never touch this cache.

**Four storage invariants:**
- Per user: `sum(bucket.quota_gb for user) ≤ netGranted(user)` — checked anywhere either side of that inequality moves: the bucket handlers (allocation up), `assertClaimDeltaAllowed` (claim down), and both transfer handlers (capacity out or clawed back).
- Per node: `sum(claim.quota_gb on node) ≤ node.capacity / replicationFactor`.
- Per user *and* node: `sum(claim.quota_gb for user on node) ≥ 0`. Without this, a user could hold −5 TB on one node and +5 TB on another and net out fine, while the negative rows silently freed capacity on the first node for other users to over-claim.
- Per transfer: a sender may only give away capacity they have *not* already allocated (`netGranted − allocated`), and a transfer may only be returned if the recipient still covers their buckets without it (else 409). Sending also subtracts what pending invites have promised — but invites are outside the invariant proper; see [Storage invites](#storage-invites).

Because ledger rows are signed, the first three checks reduce to the same question — *what does the sum look like after this delta?* — so `assertClaimDeltaAllowed()` in [webapp/src/lib/storage/claim-ledger.ts](../webapp/src/lib/storage/claim-ledger.ts) is the single guard for **every** claim mutation: POST passes `+amount`, DELETE passes `−amount`, PATCH passes `new − old` (and skips the guard entirely when that's zero, e.g. a note-only edit). No entry needs excluding from the sums. It reads the live layout via `loadClaimContext()`. Tests: [claim-ledger.test.ts](../webapp/src/lib/storage/claim-ledger.test.ts).

**The `pb` handed to `assertClaimDeltaAllowed` must be able to read every balance row** — in practice a superuser client, which is what all three call sites now pass, admin-initiated writes included. `StorageNodeBalances`/`StorageUserBalances` are scoped `user = @request.auth.id || admin`, so passing a non-admin caller's own client does not fail loudly: it silently returns only that user's rows, the node-capacity check under-counts what the node has already promised, and the guard waves through an over-claim. That became reachable the moment node owners — who are not admins — could append to the ledger.

A claim on a node absent from the layout can only be wound down, never grown. The `onlyPresent` filter already values such claims at 0, so retiring one never strands a bucket.

Reversing a grant should normally **append a negative entry**, not delete the original — DELETE exists to fix mistyped entries and rewrites history. Both the admin claims table and the user dashboard roll entries up per `(user, node)` / per node before display (via `rollUpClaimsByUserNode` / `rollUpClaimsByNode`), so the ledger never leaks into the UI as duplicate node rows. The admin "Set claim" action takes a new *total* and appends `target − current` for the same reason: restating a position must not mean rewriting how it was reached.

Per-node claims are an *accounting* construct, not data placement — Garage spreads each bucket's data across all storage nodes per its layout, so a claim doesn't pin a user's bytes to a node. Transfers lean on that: because they're node-agnostic, moving capacity between users changes neither side's per-node sums, so the node-capacity invariant is untouched and `sum(claims on node)` stays the honest measure of what a node has promised.

#### Storage invites

`StorageTransfers.to_user` is a relation, so a handoff has always needed the recipient to already exist — and the recipient lookup ran under the caller's own auth, where the Users listRule (`self or admin`) 404s for anyone else. Between them, transfers were admin-only in practice. `StorageInvites` and a superuser lookup fix both.

`POST /next-api/garage/transfers` takes one email and decides: a known address gets a `StorageTransfers` row immediately, an unknown one gets a `StorageInvites` row. The sender is not asked which case they are in — that would be asking them to know something about the recipient that is none of their business.

- **The lookup runs as a superuser** (`findUserIdByEmail` in [webapp/src/lib/storage/invites.ts](../webapp/src/lib/storage/invites.ts)), which is what makes user-to-user transfers work at all. Name the cost: whoever calls it learns whether an address has an account. It is confined to the transfer path, where the caller already knows the address they typed. The same superuser read labels transfer rows with counterparty emails for the dashboard — `GET /next-api/garage/transfers` returns `from_email` / `to_email`, because a list of raw PB ids told the recipient nothing about who had sent them a terabyte.
- **An invite promises; it does not reserve.** No balance moves until it becomes a transfer, so the balance hooks ignore the collection entirely and all four invariants keep one definition apiece. The mitigation on the writing side is `getPendingInviteGb()`, subtracted from available capacity when *sending* — one gigabyte cannot be promised to five people. It is deliberately **not** subtracted when allocating a bucket: that would put a promise inside the per-user invariant. So a sender who invites and then fills their buckets can leave an invite unpayable, and that is a state the claim path has to handle rather than prevent.
- **The claim is a route handler, not a signup hook.** `POST /next-api/garage/invites/claim` converts every pending invite for the caller's address; the dashboard calls it on load, which is what makes "sign up and the storage is there" true. A PB hook could not do this job correctly — settling an invite needs the sender's *layout-filtered* position, and a hook cannot reach Garage to learn which nodes are still in the layout (the same reason `StorageUserBalances.claims_gb` is stored unfiltered). Here the check is character-for-character the one guarding a direct transfer.
- Invites settle **oldest first and strictly in sequence**, because each conversion changes the sender's available capacity and the next invite from that sender must see it. Running them concurrently would let two invites both pass a check only one can afford. A sender who has run out does not block the rest: that invite goes to `failed` with a reason the sender reads on their dashboard.
- The claim is idempotent — an invite leaves `pending` on the first pass either way — so calling it every dashboard load costs one indexed lookup. It is also non-fatal on the client: it needs Garage for the layout, and a dashboard that refused to render because an optional pickup failed would be the worse trade.
- The **email is a separate hook**, `onRecordAfterCreateSuccess` on `StorageInvites` in [pocketbase/pb_hooks/main.pb.js](../pocketbase/pb_hooks/main.pb.js) — deliberately *not* a request hook wrapped in `withRecordTx` like the balance hooks. The invite is the record of the promise, and a bounced email must not delete it, so mail is best-effort: it logs and moves on. It links to `/signup?email=…`, which prefills the address (`SignupForm`'s `defaultEmail`) — signing up with a different one leaves the invite unclaimed.

Tests: [invites.test.ts](../webapp/src/lib/storage/invites.test.ts) drives the claim against a fake PocketBase and a scripted sender position.

#### Node ownership

`NodeOwners` lets a user who contributed hardware claim a cluster node by supplying its **full Garage node id**, and thereafter append `StorageClaims` entries sourced from it — to themselves or to any other user by email. Until this existed, every grant needed an admin, so anyone donating a machine had to ask permission to give away the capacity they had just provided.

**`FEATURE_NODE_CLAIMS` (default off) gates the self-claim door, not the feature.** When off, `POST /nodes/owners` refuses a non-admin claim and `DELETE /nodes/owners/[id]` refuses a self-release; admin assignment and revocation are untouched, and so is everything an existing owner may do — an owner assigned on `/admin/nodes` grants storage sourced from their node, reads `GET /claims?nodeId=`, and manages it on `/dashboard/nodes` exactly as a self-claimer would. The flag used to sit in `assertNodeOwner` instead, which made every `NodeOwners` row **inert** while it was off: an owner an admin had just assigned could not grant a single GB, and `/admin/nodes` promised a capability the guard then refused. Ownership is a property of the row, not of the deployment's appetite for self-service. The UI follows the same line — `/dashboard/nodes`, the "My Nodes" nav entry and the dashboard card are always present; `useFeatures()` hides only the claim form, the Release button and the copy that offers self-claiming.

**Ownership decides *who may append a row*, never *how much*.** An owner's write runs through character-for-character the same `assertClaimDeltaAllowed` an admin's does, so all four storage invariants are untouched and the node's ceiling stays `capacity / replicationFactor`. There is no new arithmetic anywhere in this feature, and that is the property to preserve when extending it.

**The full node id is the credential, and this route is the reason nothing else may emit one.** A **claim** body — anyone naming themselves, and any non-admin — must be a **full 64-character id**, never a node key: `isFullNodeId`, not a prefix match. Accepting a prefix there would hand ownership of any node to anyone who can read a page, since the key is on screen, in every payload and in every URL. **An admin *assignment* carries the key instead**, because that is the only node identifier the admin console has or is allowed to have — no route emits a full id and no page renders one, so requiring the credential at `/admin/nodes` made admin assignment a permanent 400. An admin needs no proof because there is nothing for it to add: they can already assign any node to any user and revoke it again. **The test is conditional on the *caller*, never on the value submitted** — a non-admin can produce no argument that turns a key into proof — and the zod refine deliberately checks only the *shape* (either form), leaving the admission decision in the handler where the caller's admin status is known. Either way the identifier is matched against the live layout and then **discarded**: what `NodeOwners.node_id` stores is `nodeKey(id)`, because a credential kept in a database is a credential that can leak from one. See [Node identity](#node-identity) for the split, which is what closed the ACCEPTED GAP that stood here — under which every full node id was readable from `/cluster/nodes` and from `NodeMetrics`, making a claim first-come-first-served among *all* signed-in users.

> **What possession proves, and what it does not.** Node ids are gossiped between peers, and one authenticated `GetClusterStatus` returns every node's. So holding one proves *access to the Garage admin surface* — in this deployment, the private VPN the CLI lives on — rather than control of that particular machine. Between operators, claiming is therefore still first-claim-wins. The compensating controls are that the `UNIQUE` index settles the race, the `node_owner_changed` timeline row makes it attributable to a named human on a page every signed-in user reads, and an admin can revoke. The id being unguessable is what keeps everyone else out; those three are what keep operators honest with each other. A stronger proof is not available — Garage exposes no endpoint that will sign a challenge with a node's private key.
>
> **No rate limiter, deliberately.** `setup/claim` has a backoff and this does not, and the difference is the size of the secret: that token is 32 characters and its real guard is the empty-`Admins` check rather than its secrecy, whereas here an attacker holding the public key still has to produce 48 unknown hex characters. A speed bump would be theatre. Refused claims are logged instead, which is the thing an operator can act on.

- **One owner per node, enforced by `UNIQUE (node_id)`** — and the index *is* the concurrency control. [webapp/src/lib/setup/claim.ts](../webapp/src/lib/setup/claim.ts), this repo's other claim-with-a-secret flow, could only narrow its read-then-write race with a process-global promise mutex that it admits does not span replicas. Here the database expresses the constraint directly, so `POST /next-api/garage/nodes/owners` has no mutex and no backoff: it attempts the insert and translates a uniqueness violation into a 409. **Do not "optimise" that into a pre-flight existence check** — a check-then-act pair is exactly what the index exists to make unnecessary.
- **Claiming validates against the LIVE layout**, never `@/lib/garage/cached`. It decides whether capacity exists to own, which makes it a validator, and the cache rule in [Cluster read cache](#cluster-read-cache) is absolute about those. A node absent from `layout.roles` is a 404; a node with no declared capacity is a 400, because a gateway backs no storage and `assertClaimDeltaAllowed` would refuse every positive delta against it — owning one would be inert.
- **`assertNodeOwner`** ([webapp/src/lib/auth/ownership.ts](../webapp/src/lib/auth/ownership.ts), beside `assertBucketOwner`/`assertKeyOwner`) reads through the **caller's own** `pb` and needs no superuser: the `NodeOwners` listRule is self-or-admin, so a lookup by node id returns a row iff the caller owns it — the same self-scoped-lookup trick `isUserAdmin` plays against `Admins`. A null result therefore means *"not yours"*, which is **not** the same as *"unowned"*; nothing there may be read as evidence that a node is free to claim.
- **Granting is by email, to existing accounts only.** The Users listRule is self-or-admin, so a non-admin cannot resolve a recipient id from the browser; `POST /claims` accepts `user_email` and resolves it with `findUserIdByEmail` as a superuser. An unknown address is a plain **404 — no `StorageInvites` row is written**. An invite is a *transfer* held in escrow, and giving it a second meaning would put a promise inside the per-node invariant. Reaching a stranger means granting to yourself and handing it on through `/transfers`, which already escrows, emails and settles on signup.
- **`GET /claims?nodeId=` is open to the node's owner**, not only to admins, and **reads through a superuser once `assertNodeOwner` has passed**. Name the disclosure: an owner sees every claim on their node, including which other users hold capacity there. That is inherent to being asked to keep a ceiling — you cannot manage what you cannot see — and it is scoped to nodes they own; it reveals no user's position anywhere else. The escalation is not an optimisation but the whole point of the route: `StorageClaims` is scoped `user = self || admin`, so serving this through the caller's own client silently returns their *own* rows only, and `/dashboard/nodes` then subtracts the wrong figure from the node's capacity and offers storage that is not there — the same trap, and the same fix, as the `pb` handed to `assertClaimDeltaAllowed`. `GET /claim-audit?nodeId=` stays admin-only.
- **Releasing is a delete; there is no PATCH**, and `POST` assigns an *unowned* node only — the `UNIQUE` index answers 409 for one that is already held. Reassignment is delete + create, so every change leaves its own timeline row and there is no partial-edit path — the reasoning behind `StorageTransfers.updateRule: null`. Ownership changes never move storage: the ledger is append-only and its entries record what was granted, not who was entitled to grant it, so revoking a node leaves every claim sourced from it exactly where it was.
- Ownership changes append a `ClusterEvents` row (`kind: 'node_owner_changed'`, `source: 'action'`), with the raw PB user ids in `previous_value` / `new_value` — empty meaning unowned. One kind, not three: which verb it was reads off that pair, exactly as `repair` keeps the operation in `new_value`.

UI: `/dashboard/nodes` claims and manages; `/admin/nodes` lists every node in the layout with its owner or "Unowned" and can assign or revoke. The grant dialog is the existing [set-claim-dialog.tsx](../webapp/src/components/admin/set-claim-dialog.tsx), generalised rather than forked — omitting `userId` switches it to an editable address resolved server-side.

#### Deleting and retiring

`deleteKey` and `deleteBucket` both used to `throw new Error('... temporarily disabled while testing')`. That broke four things at once: both DELETE routes returned a **500 rendering that developer string into a user's toast** — after an OTP challenge and a typed resource name — and both create-path rollbacks silently stranded the Garage object they had just made. For a key that orphan is unrecoverable: the secret is returned only on the success path, so nobody holds it, it cannot be claimed back, and only an admin import can adopt it.

**They were never working code that got commented out.** Both commented bodies put `id` in the request body, but `DeleteBucket` and `DeleteKey` declare it a **required query parameter** with no request body at all — `buildUrl` only serialises `query`, so they would have posted a delete naming nothing. `buckets.ts` did not even import `z`. `updateKey` carried the identical defect and had no callers, which is why nobody had noticed.

**The threat model is somebody using this app to grief** — a session-holder destroying what cannot be restored — not operator error and not incident response. That, not squeamishness, is what shapes the two halves:

- **A bucket can be deleted only when empty.** That is Garage's own rule (`400 "Bucket is not empty"`), so the app enforces what the cluster enforces and simply says it better. `describeBucketEmptiness()` in [bucket-emptiness.ts](../webapp/src/lib/storage/bucket-emptiness.ts) is the pre-flight, and it **fails closed**: the spec never defines what "empty" means to Garage and our schema keeps every counter optional, so an absent counter reads as "not known to be empty". The route refuses with the object count and size and points at the bucket's Connect page — the in-app browser can list, upload and download but **not** delete, so emptying genuinely happens in the user's own S3 client. The same helper drives the disabled button on the page, so a 409 and a greyed-out control can never disagree.
- **A key is expired, never deleted.** `POST /next-api/garage/keys/[id]/expiry` takes `{ expired: boolean }` and writes nothing to PocketBase — the `AccessKeys` row is the record that the key is yours, and expiry is Garage state, read back by joining one `ListKeys` call in `GET /keys` rather than mirrored into a column. **Un-expiry is the safety property, not a convenience:** a retire button with no way back would be exactly the griefing lever this design refuses elsewhere. A hard delete stays with `garage key delete` on the cluster.

> **Expiry really does stop S3 access, and the vendored spec does not say so.** `docs/GarageHQ_OPENAPI.json` defines `expired` as key state with no description and says nothing about enforcement. Garage's **v2.0.0 release notes** are the source: expiration applies to "the standard S3 access keys used by client applications to read and write to your buckets", letting an operator "issue temporary S3 credentials that automatically expire". `docs/` vendors no release notes, so anyone checking only the spec will hit the same gap — hence this note.

Three rules hold the rest together:

- **A delete that finds nothing has succeeded.** `GarageNotFoundError` from either delete resolves rather than throwing. Without it, the one tear the Garage-first ordering leaves — Garage deleted, PocketBase didn't — was permanent: every retry 404'd *before* the PocketBase delete, so the row could never be cleared, went on reserving `allocated_gb`, and went on feeding the daily alert cron about a bucket that no longer existed. Retry is now the self-heal, and no new admin surface was needed. `DeleteKey` documents no 404 at all, but `GetKeyInfo` documents none either and we already rely on one, so the spec's response lists are treated as incomplete rather than exhaustive.
- **Ordering stays Garage-first.** For keys it is the only safe order — kill the credential, then the bookkeeping. For buckets a surviving PocketBase row is visible and now fixable, whereas the inverse would silently free quota while the data stayed.
- **An expired key proves nothing.** Bucket ownership is *derived* from holding a key Garage marks `owner`, so `liveKeyIdsFor()` in [live-keys.ts](../webapp/src/lib/storage/live-keys.ts) drops expired keys before `buckets/claim` and `buckets/claimable` consider them — otherwise a credential the user deliberately retired would still confer the right to take over buckets. It fails closed: an unreachable Garage means no key counts as live.

`deleteKey` remains real and has exactly one caller, the create-path rollback in `POST /next-api/garage/keys`. There is deliberately no user-facing door to it.

#### Claiming existing keys and buckets

The secondary onboarding path, alongside [Node ownership](#node-ownership): assets that already exist in Garage — made with the CLI, or before this control plane did — have no PocketBase owner, and the only way to attach one used to be an admin picking a user off a list in `/admin/keys` or `/admin/buckets` with no proof of anything. `POST /next-api/garage/keys/claim` and `/buckets/claim` let the cluster do the checking instead. **Creating keys and buckets in the app stays the primary path**; these two routes exist so somebody arriving with assets already in the cluster can onboard themselves.

**Both routes are behind `FEATURE_ASSET_CLAIMS` (default off).** When off, `POST /keys/claim` and `POST /buckets/claim` answer a flat 403 before doing any work (no body parse, no backoff, no Garage call), and `GET /buckets/claimable` answers `{ items: [] }` rather than 403 — it sits in a `Promise.all` on `/dashboard/buckets`, and an empty list is the conclusive fail-safe answer the card already renders as nothing. There is deliberately **no admin bypass** on the claim routes: an admin cannot know the secret, and their door stays `keys/import` / `buckets/import`, which the flag never touches. The keys page hides its "Claim existing" control via `useFeatures()`.

**One credential bootstraps everything.** The secret access key is the only thing a user holds that the cluster can verify, and Garage already records which keys own which buckets, so bucket ownership is *derived* rather than separately asserted:

```
secret access key ──proves──► you own the key ──Garage `owner` perm──► you own the bucket
```

- **The key claim is the only real credential check.** `verifyKeySecret()` in [lib/garage/keys.ts](../webapp/src/lib/garage/keys.ts) fetches the true secret (`showSecretKey=true`), compares it with `tokenMatches` — the same constant-time compare `setup/claim.ts` reasoned through — and **returns a boolean**. The secret never becomes a value a handler can hold, so it cannot be logged, echoed or stored; `AccessKeys` has no column for one. Garage has no "is this secret correct" endpoint anywhere in v2, so the comparison has to happen here, which is exactly why the function is shaped to give nothing back.
- **`getKeyInfo` no longer asks for the secret, and `GarageKeySchema` no longer has the field.** It used to pass `showSecretKey: 'true'` unconditionally, and `GET /next-api/garage/keys/[id]` returned the parsed result verbatim — so the live secret was served to the key's owner *and to every admin*, while the UI two pages away said secrets could never be retrieved after creation. Two narrow local schemas may still carry one (the create path's one-time reveal, and the verifier); neither is reachable from a response type. [key-secret.test.ts](../webapp/src/lib/garage/key-secret.test.ts) is the guard.
- **"No such key" and "wrong secret" are the same 403, word for word.** Distinguishing them would make the route an oracle for which access key ids exist, and `garage key list` makes those cheap to enumerate. `verifyKeySecret` returns `false` for a missing key rather than throwing, so the single answer is the natural way to write the handler rather than a discipline to remember. **The ordering is the mirror of `setup/claim.ts`** — that route checks claimed-*before*-token so an already-claimed instance answers identically either way, whereas here proof comes first and state second, because someone who has produced the secret has earned the real answer.
- **The bucket claim proves nothing by itself** — a bucket id is an identifier, not a credential, and `buckets/unallocated` already lists every unowned one to admins. It asks Garage instead: does the caller hold a key that Garage marks `owner` on this bucket? `ownedBucketKeyFor()` in [lib/storage/bucket-claim.ts](../webapp/src/lib/storage/bucket-claim.ts) is that rule, pure and structurally typed so a test can drive the whole permission matrix. **`owner`, not read/write:** a key with read/write holds a grant somebody gave it, which on a shared bucket is not the same as owning the thing. All three flags are optional in Garage's schema, so the check is `=== true` — an absent flag is "no", never "unknown". A bucket with no owner-flagged key simply is not self-claimable; `POST /buckets/import` still covers it.
- **`GET /buckets/claimable` is what makes it discoverable.** Claiming a key populates it. It discloses nothing new — every bucket listed is one the caller's own key owns, readable from Garage with their own credentials — which is why it is safe on a `getServerUser` gate. The caller's `AccessKeys` are read through their **own** client: the listRule is self-or-admin, so a superuser read would return everyone's and the match would silently become "does anyone own this bucket". **The cheap question is asked first, and that ordering is the design.** `/dashboard/buckets` fires this on every load and every refresh, and for almost everybody the answer is empty forever — onboarding happens once. So one `ListBuckets` plus one superuser read of `Buckets.garage_bucket_id` settle *is there anything unclaimed in the cluster at all*, and on a deployment where everything has been claimed the per-key `GetKeyInfo` fan-out never runs. Asking the per-key question first costs one Garage call per access key on every page load and then throws the answer away. The unclaimed set doubles as the already-claimed filter, which is why there is no second PocketBase read building a filter string out of bucket ids.
- **Self only, no admin escalation**, unlike `nodes/owners`. An admin assigning an orphaned key cannot know its secret, so a unified route would need an "if admin, skip the proof" branch — a conditional admission test, which is the shape that goes wrong. Two authorities, two doors: `import` stays admin-and-proofless, `claim` stays user-and-proven.
- **UNIQUE indexes are the concurrency control**, as on `NodeOwners.node_id` — `isUniqueViolation(err, field)` in [lib/storage/unique-violation.ts](../webapp/src/lib/storage/unique-violation.ts) translates the violation to a 409, and there is deliberately no pre-flight existence check (the `import` routes still make that mistake). The `field` argument is load-bearing: `Buckets` has **two** unique indexes and they mean different things — `garage_bucket_id` is "already claimed", `name` is "a different bucket is registered under that alias". **The match is on PocketBase's `validation_not_unique` code, not on the field name appearing in a 400** — every other per-field validation failure (a name over its max length, a value failing a pattern) arrives in the same shape, and reporting one as a collision sends the user hunting for a conflicting record that does not exist. An unrecognised code falls through to a 500, which is the safe direction.
- **No cluster-timeline row**, unlike a node claim. `/next-api/garage/cluster/events` projects that timeline to every signed-in user, so a title naming a bucket or a key would broadcast it cluster-wide. The PB row and its `created` stamp are the record; admins already read every row. Refusals are logged with the **access key id only** — the submitted secret is never logged at any level.
- **A modest backoff, where the node route has none.** [lib/auth/backoff.ts](../webapp/src/lib/auth/backoff.ts), extracted from `setup/claim` once there were two users. The reasoning differs from the node route: a Garage secret is unguessable there too, but here each attempt costs a **Garage admin API round trip**, so it is a request-amplification vector rather than only a guessing one. It is a per-route process-global speed bump, not a rate limiter, and the module says so.

**Quota on a bucket claim: adopt if it fits, otherwise zero.** The claim never fails on capacity — being unable to onboard your own bucket because nobody has granted you storage yet would defeat the point — so it adopts Garage's live `maxSize` when `allocated + quota <= granted` and records `0` when it does not, saying which in the response. That leaves a claimed-at-zero bucket reserving nothing while holding real bytes, which is an already-modelled state (the `over-quota` segment on the storage chart, drawn and never clamped away); bringing stored bytes inside the invariant would be a storage-accounting change, not a claim change.

> **`syncQuotaToPb` had to be fixed for that to be stable, and it was a pre-existing bug.** It adopts Garage's `maxSize` into `quota_gb` whenever the two disagree, from `refreshBucketsFromGarageBackground`, on **every dashboard load** — and the Buckets update hook then raises `allocated_gb`. So it was the one path that could breach `sum(quota_gb) <= netGranted` with no request to reject and nothing to notice, reachable today by raising a `maxSize` out of band. It now refuses an **increase** the owner has no room for, logs it, and leaves the disagreement for `/admin/quota` to show. It **returns** a `QuotaSyncOutcome` (`written` / `unchanged` / `refused` with a reason) rather than resolving silently: the silence is correct on the read path and wrong on `POST /buckets/reconcile`, where an admin has explicitly asked for the repair and counting a refusal as `synced` reports a job the drift page contradicts on the next render. The two refusals — *does not fit* and *could not tell* — are told apart in the reason, because one is a decision and the other is a fault. A decrease is never checked — it can only free capacity, and must not be blocked by a user who is already over-allocated. The check fails **closed**, and reads the **cached** layout: this is a self-heal on a display path, and blocking a page load on Garage to decide whether to rewrite a number is the worse trade. The claim route itself reads live, because it is a validator.

#### Claim audit trail

`StorageClaims` is append-only, but only over the rows that *currently exist* — a PATCH rewrites an amount and a DELETE removes an entry, and neither leaves a trace. `StorageClaimAudit` is that trace, and the hooks at the top of [pocketbase/pb_hooks/main.pb.js](../pocketbase/pb_hooks/main.pb.js) write it.

- **Hooks, not route handlers.** The handlers already know the actor and the before/after, so writing it there would be simpler — but the hooks also catch writes made through the PocketBase admin UI or a direct SDK call, which is precisely what an audit trail is for.
- **The actor arrives in a request header, not from `e.auth`.** Since `StorageClaims`' write rules became `null`, *every* claim write authenticates as the deployment's PocketBase superuser — so `e.auth` names a service account, and attributing owner grants to it would gut the trail for exactly the least-trusted actor. `/next-api/garage/claims` sends `X-Claim-Actor-Id` / `X-Claim-Actor-Email` / `X-Claim-Source` (built by `actorHeaders()` in [claim-write.ts](../webapp/src/lib/storage/claim-write.ts)) and `resolveActor()` in [claim-audit.js](../pocketbase/pb_hooks/lib/claim-audit.js) reads them. **The `e.hasSuperuserAuth()` guard is the whole security property**: headers are trivially forged by anything that can make a request, so they count for nothing without credentials no browser holds — under any other auth they are ignored outright and `e.auth` is the answer, which also keeps this correct if a write path is ever reopened. An unrecognised `X-Claim-Source` is downgraded to `api` rather than rejected, because the column is a select field and an out-of-enum value would roll back the claim change it was describing; `cascade` is refused from a header, since only the hook that knows a cascade is happening may say so. A superuser working in the PocketBase admin UI sends no headers and is attributed `superuser`, which is the honest reading. `resolveActor` is deliberately pure — no Goja globals, no `require`, no clock — so [claim-actor-lib.test.ts](../webapp/src/lib/storage/claim-actor-lib.test.ts) drives it from vitest across the workspace boundary, the same arrangement as `diffObservations`.
- **`*Request` hooks specifically.** Only `RecordRequestEvent` carries `e.auth` (it embeds `RequestEvent`); `onRecordAfter*Success` gets a `RecordEvent` with no actor. The cost is that request hooks don't fire for cascade deletes, so a fourth hook on `Users` snapshots the user's claims and email *before* `e.next()` and writes them as `source: 'cascade'` *after* it succeeds.
- **`withRecordTx`, never a bare `e.app`.** Inside a request hook `e.app` is *not* transactional — the record save that `e.next()` runs commits on its own, and PocketBase writes the HTTP response from inside that same call. Anything written afterwards against `e.app` is an unprotected write against an already-committed record that has already been reported as successful. [pocketbase/pb_hooks/lib/record-tx.js](../pocketbase/pb_hooks/lib/record-tx.js) wraps the handler in `e.app.runInTransaction()` and reassigns `e.app` to the tx app *before* `e.next()`, so the save joins that transaction and the response is deferred to commit. Then a failed audit write does what it should: rolls the change back and fails the request loudly, rather than a 200 with a silently missing entry.
- **Helpers must be `require`d inside each handler.** Goja runs every callback in a fresh executor, so top-level declarations in `main.pb.js` are invisible to them — the shared builder lives in [pocketbase/pb_hooks/lib/claim-audit.js](../pocketbase/pb_hooks/lib/claim-audit.js), a plain `.js` (not `.pb.js`, which PocketBase would load as a hook file in its own right).
- `delta_gb` is signed and directly comparable to the `deltaGb` handed to `assertClaimDeltaAllowed`: create is `+amount`, delete is `−amount`, update is `after − before`.
- **`previous_gb` / `new_gb` are the *entry's* own value, not the position** — so a create always reads `0 → amount`, which beside an existing 36 TB claim renders as "0 B → 4 TB" and looks like a wipe. The position is deliberately not stored: a hook writing one would be trusting its own history, and backfilling the column would restate rows in a collection whose whole point is that it is never restated. `/admin/claims` derives it instead — `positionsForAuditTrail()` in [ledger-math.ts](../webapp/src/lib/storage/ledger-math.ts) walks the signed deltas back from the pair's current ledger sum, anchored on the **present** so a trail that doesn't reach the pair's first entry loses precision only at the far end. `/admin/ledger` mixes users and nodes on one page and so cannot derive it; it shows the entry pair for an `update` only, and `—` for a create or delete where it would restate `delta_gb` with a misleading zero.

Read it via `GET /next-api/garage/claim-audit` (admin-only; filters `userId`, `nodeId`, `claimId`, `action`, paged). Surfaced at `/admin/ledger` and inline in each expanded `(user, node)` row on `/admin/claims`.

#### Storage balances

`StorageNodeBalances` / `StorageUserBalances` are a **cache** of the two ledgers, so reading a position costs O(nodes) instead of O(ledger entries). The ledgers only grow; every per-user sum used to read one page of one, which is a silent wrong answer waiting on row count — and those sums backed `assertClaimDeltaAllowed`, the guard on every claim mutation.

**Why per `(user, node)` and not one net figure per user.** A claim on a node that has left the layout must count as zero, and a PocketBase hook cannot reach Garage to learn which nodes those are. Keeping the breakdown lets the layout filter stay where it can be applied correctly — at read time, in `computeSummaryFromBalances`. A hook-written `net_granted_gb` would silently keep counting decommissioned hardware. For the same reason `StorageUserBalances.claims_gb` is the *unfiltered* cross-node sum and must never be used as the grant; it exists to detect drift.

**Maintenance** — all writes go through [pocketbase/pb_hooks/lib/storage-balance.js](../pocketbase/pb_hooks/lib/storage-balance.js):

- The claim hooks do double duty: audit row **and** balance update, in the same handler after the same `e.next()`, inside the same `withRecordTx` transaction. Splitting them would only create a way for them to disagree. Every balance-maintaining hook (claims, transfers, buckets, the `Users` cascade) is wrapped the same way — the read-modify-write in `applyClaimDelta` needs it twice over, since `StorageNodeBalances` has a `UNIQUE (user, node_id)` that two concurrent claims on the same pair would otherwise race.
- `StorageTransfers` (create/delete) and `Buckets` (create/update/delete) have their own hooks. The Buckets update hook skips rows where `quota_gb` didn't move — most Buckets writes are the usage-cache refresh on every dashboard load.
- **Cascades are the subtle part.** `StorageTransfers` cascades from *both* parties, so deleting a user silently removes transfers the counterparty is still owed — and no transfer hook fires. The `Users` delete hook unwinds the survivor's side inline; leaving it to the nightly rebuild would let them over-allocate in the meantime.
- **Backfill lives in the migration** ([1786122444_created_StorageUserBalances.js](../pocketbase/pb_migrations/1786122444_created_StorageUserBalances.js)), *not* an `onBootstrap` hook. Migrations run **after** bootstrap fires, so a hook-based backfill finds no collections on exactly the upgrade boot that has data to backfill — verified the hard way. Don't move it.
- A nightly cron (`storage-balance-rebuild`) and `POST /next-api/garage/storage-balances/rebuild` (admin, proxied to a superuser-only PB route added with `routerAdd`) both call the same `rebuildAll`. One implementation on purpose: a second one in TypeScript could disagree with the hooks it is meant to be auditing.

A non-zero `corrected`/`last_drift_gb` from a rebuild is **a bug, not routine maintenance** — it means an incremental hook missed a write path. Node-level corrections are folded into the owning user's `last_drift_gb` so the affected user is identifiable.

`last_drift_gb` and the returned `driftGb` are the **worst single correction, signed** — not a net and not a sum. A net cancels (5 GB short on claims plus 5 GB over on allocated nets to zero and reports a doubly-wrong row as clean); a sum over-reports, because one missed `applyClaimDelta` leaves both the node row and the user row short by the same amount, so adding them states one discrepancy at twice its size. Every field is compared on its own, and the largest disagreement wins.

#### Cluster read cache

Loading `/dashboard` used to mean, per load: `GetClusterLayout` three times (invite pickup, storage-summary, cluster/nodes), a `GetClusterStatus` + `GetClusterStatistics` peer fan-out, `GetBucketInfo` once per bucket, and two uncached `_superusers.authWithPassword` bcrypts. None of it is realtime — a layout changes when an operator changes it — so the display paths now read through `GarageClusterCache`.

[webapp/src/lib/garage/cached.ts](../webapp/src/lib/garage/cached.ts) is the whole implementation: `getCachedLayout` / `getCachedStatus` / `getCachedHealth` / `getCachedReplicationFactor`, all one private `readThroughCache`. Fresh row (within TTL — layout 60s, status/health 30s, replication factor 1h) returns with zero Garage calls; a stale row returns immediately and refreshes behind the response; a miss, or a payload the schema no longer accepts, blocks on Garage and writes through. **With Garage unreachable a stale row is served whatever its age** — there is no maximum staleness, because riding out an outage is the point; only a cold cache still errors.

Three things hold it together:

- **Validators never read it.** Claim mutations, transfer sends/returns, bucket quota validation, and invite settlement keep calling `cluster.getLayout` live. A stale layout must not decide whether capacity exists. This is the rule to check first when adding a handler.
- **`getPbAsSuperuser()` is memoized** ([auth/server.ts](../webapp/src/lib/auth/server.ts)) — a module-level client plus an in-flight auth promise, so N parallel misses cost one bcrypt rather than N. The cache collection's rules are all `null`, so every read of it needs that client; without memoization the cache would have cost more than it saved.
- **Refreshes are deduped per key in-process** (a module-level `Map`), because one dashboard load fans out into three handlers that all want the layout. Cross-process races fall to `upsertByKey`'s unique-index catch: the loser re-reads and updates, and both writes are fresh.

Two more paths were reordered rather than cached. `POST /invites/claim` now takes the layout as a thunk, so the common "nothing pending" case costs one indexed PB read and no Garage call at all (it stays *live* when invites do exist — it writes transfers). And `GET /buckets` serves the `Buckets` usage columns it was already maintaining, calling `refreshBucketsFromGarageBackground` off the response path; it only blocks on Garage for buckets with no `usage_updated_at` at all, where there is nothing cached to serve and an imported bucket may hold real data. The refresh is deliberately ungated by any TTL — the daily `bucket-usage-alerts` cron depends on dashboard reads keeping those columns current.

Node-metrics paths are untouched and separate: the scrape runs inside the PB process via `$http.send`, and reads are PB-only. That includes the scrape's `GetClusterLayout` call — **it cannot use `getCachedLayout`**, and the obvious "optimization" would break the boundary in both directions: `cached.ts` is `import 'server-only'` Next.js code and the only reader and writer of `GarageClusterCache`, while the scraper is Goja running in the PocketBase process with no access to either. A scrape is also a *sample*: recording a layout reading the cache took a minute ago would silently mislabel when the cluster was in that state.

#### Bucket quota drift

`Buckets.quota_gb` and Garage's `quotas.maxSize` are written by separate calls in `PATCH /next-api/garage/buckets/[id]` with no rollback, so a failure between them leaves the two disagreeing.

`describeQuotaDrift()` in [quota-sync.ts](../webapp/src/lib/storage/quota-sync.ts) compares **both** axes. The object-count one had never been checked: absent an override, `maxObjects` derives from `GARAGE_AVG_OBJECT_SIZE_MB`, so changing that setting leaves every existing bucket on a stale cap with nothing to notice. `quotaHasDrifted()` stays deliberately size-only because it drives the automatic read-path self-heal — quietly rewriting a live object limit on a page load is not something a GET should do.

- `GET /next-api/garage/buckets/quota-audit` (admin) — every bucket with both sides, the drift flags, live usage, and the owner's email. A bucket whose Garage fetch fails is `status: 'unknown'`, never `ok`: not knowing is not the same as agreeing. It reads `getFullList`, so it is the *complete* list — the reason the quota page reads usage from here rather than joining against `/buckets?all=true`, which serves one 200-row page.
- `POST /next-api/garage/buckets/reconcile` (admin) — `direction: 'adopt-garage'` (default, the historical behaviour) or `'push-pb'`, which is what repairs a half-applied PATCH where adopting would discard the admin's actual change. Optional `includeObjects` and `bucketIds`. A bucket counts toward `synced` only if something was actually **written** for it; a `syncQuotaToPb` refusal counts as `failed` and names its reason in `errors`. Every write in it goes through **one** superuser client resolved at the top — `Buckets`' write rules are all `null`, and having a single client in scope is what stops a second branch being added against the caller's `pb`, which is how the object-quota clear came to be rejected on every call.
- Surfaced on **`/admin/quota`**, grouped by user, with bulk reconcile behind the OTP gate and a per-bucket **Change quota** dialog behind a type-the-bucket-name challenge. `/admin/buckets` is a plain sortable inventory and carries none of this.

> **Neither gate is server-enforced.** `authWithOTP` runs in the browser and its only effect on app code is a React boolean; the name challenge is likewise just a React boolean. No route handler reads either, so a `curl` with an ordinary session token bypasses both — for bucket delete, key revoke, key create, permission toggles, and the admin quota override. They guard against a careless click, not a stolen session. Making the OTP real means sending `otpId` + code with the request and verifying server-side. Don't mistake the dialog for enforcement.
>
> The two gates answer different questions, which is why the quota dialog uses the challenge rather than the OTP: an OTP asks *is it still you*, a name challenge asks *did you mean this bucket*. Editing a quota on the wrong row is the failure an OTP does nothing about.

#### Object quotas

`Buckets.object_quota` is the authoritative object-count cap: **> 0 is an explicit admin override; 0 or unset means "derive from `GARAGE_AVG_OBJECT_SIZE_MB`"**, the historical behaviour. There is deliberately no way to say "explicitly uncapped" — Garage treats `maxObjects` 0 and null identically, so a stored 0 could never be distinguished from an absent override.

It exists because the object axis was previously *only* derived, so an admin could not set an object cap at all: any cap written straight to Garage would be reported as drift forever and reverted by the next bulk reconcile. `describeQuotaDrift` now measures Garage against the override when one is set, so a deliberate cap reads as clean.

- `effectiveMaxObjectsFor(record)` in [object-quota.ts](../webapp/src/lib/storage/object-quota.ts) — "what should this bucket be capped at". **Every write of a `maxObjects` to Garage goes through it**, so a user resizing their own bucket never recomputes an admin's override away. `maxObjectsForQuotaGib(gib)` is the plain derivation, for the two places with no record to consult (bucket creation, and adopt-garage right after clearing an override).
- The arithmetic lives in [object-cap.ts](../webapp/src/lib/storage/object-cap.ts), which is deliberately **not** `server-only` (like `units.ts` and `ledger-math.ts`): the admin quota dialog has to show the cap a bucket *would* derive as the size input changes, and a second hand-rolled copy in a component is how the two would come to disagree. Only the env read stays server-side.
- An object cap is **not** validated against the owner's storage claim. There is no object ledger and no per-user object grant — all four storage invariants are size-denominated — so `PATCH /buckets/[id]` deliberately skips the layout fetch and balance reads on an object-only edit.
- `adopt-garage` has two branches for this axis. When Garage enforces a cap, adopting records it into `object_quota` (the live limit does not move, only the disagreement). When Garage caps nothing, there is no PB value to adopt — `0` means "derive" — so it clears any stale override and writes Garage the derived cap instead.
- Garage's `quotas` object **replaces both axes** on every `UpdateBucket`, so an object-only edit must still re-send `maxSize`, or the size quota is silently dropped.

#### Storage cost card

The full comparison lives on **`/dashboard/cluster`**, at the top, wearing `CLUSTER_PANEL_CLASS` from [components/cluster/panel.ts](../webapp/src/components/cluster/panel.ts) — the dashed-border, muted-fill treatment that page's event timeline already used, extracted to a constant so the two panels match by construction rather than by coincidence. It carries **two sections over the same rates**: the user's quota, and the cluster's whole usable capacity. Separate blocks rather than one blended figure, because they answer different questions — what am I getting, and what is this thing worth — and averaging them would answer neither. Each section's table sits in a **collapsed `View details` accordion** — the headline answers the question, the table is the evidence, and evidence should be available rather than unavoidable. Radix unmounts collapsed content, so the tables are genuinely absent from the DOM until opened; tests must click the trigger first (`expandAll()` in [storage-cost-card.test.tsx](../webapp/src/components/storage/storage-cost-card.test.tsx)). The table is **Provider · Rate/TB/mo · Monthly · Annual · N years**, where N is the configured lifespan; **Rate folds away below `md` and Monthly below `sm`**, so a phone gets three columns rather than a horizontal scroll — Annual and the lifespan total survive because they are the two figures the surrounding copy quotes. The two sit **side by side at `xl`, stacked below it** — not `lg`, because the page's container caps at `max-w-6xl` and an `lg` viewport leaves each column ~456px, enough to render a five-column table only by scrolling it, which defeats the point of the split. The grid is applied only when both halves exist; a lone section at half width with dead space beside it reads as a rendering fault. Bars were the wrong mark here: the figures span nearly two orders of magnitude, so this cluster's row came out ~27x shorter than S3's and had to be floored to a visible minimum to render at all, at which point it no longer showed the ratio it existed to show. The last column is the one that lands, and it is self-checking: **over the hardware's life this cluster's total equals the disk purchase price exactly** (36 usable TB at RF 3 → 108 raw TB × $22 = $2,376), because a lifespan of amortized capital is the capital. [rates.test.ts](../webapp/src/lib/pricing/rates.test.ts) asserts that identity across every lifespan and replication factor — it is what breaks first if the amortization is wrong. `/dashboard` carries only [storage-cost-summary.tsx](../webapp/src/components/storage/storage-cost-summary.tsx): a single full-width band with what the quota costs here, a saving per provider, and a CTA to the cluster page. **Below `sm` only the cheapest provider's saving is shown** — one comparison fits on a phone, and it should be the hardest test of the claim rather than the most flattering one. It is `cheapestAlternative(rows)`, the same helper the panel headlines with: picked by total cost, not by taking the last row, so it survives a reordering; both figures stay in the DOM, since this is a layout choice and not a different set of numbers for phones. The split is the point. A full pricing panel was taking a screenful of a working dashboard to make an argument the user needs to read once; the panel now sits next to the cluster it is arguing for. Each component carries a test asserting it has not grown back into the other (`<table>` absent on the panel, no bars or provider list on the summary), and the panel carries no CTA because it lives on the page it would link to.

Both price the user's **total storage quota** — `StorageSummary.netGrantedGb`: what an admin granted, **plus storage gifted by other users**, less anything gifted away — against two commercial reference rates and against this cluster's own amortized hardware cost. The quota is the like-for-like figure, since capacity you hold from a provider is capacity you pay them for. **"Claim" is the ledger's term and stays in the accounting code and the admin console; every user-facing surface says "quota".** It is a value/ROI panel and the platform's one call to action to invest in the cluster. [webapp/src/components/storage/storage-cost-card.tsx](../webapp/src/components/storage/storage-cost-card.tsx) is presentation only; all the arithmetic is in [webapp/src/lib/pricing/rates.ts](../webapp/src/lib/pricing/rates.ts).

**It lives in `lib/pricing/`, not `lib/storage/`** — the same reason [data-coverage.ts](../webapp/src/lib/metrics/data-coverage.ts) lives in `lib/metrics/`. Nothing in the storage-accounting path may import it, and a GB-denominated cost module sitting beside `ledger-math.ts` is an open invitation for a dollar figure to typecheck its way into a ledger call site. The dependency is one-way: `lib/pricing/` may import `lib/storage/units.ts`; nothing under `lib/storage/` may import `lib/pricing/`.

- **Bytes in, decimal TB for the rates.** Every function takes bytes — deliberately *not* the codebase default, since every `*Gb` field in the ledger holds binary GiB, which is exactly why this module refuses to speak in "GB" at its edges. Callers convert once with `gibToBytes`. Rates are per **decimal TB (10¹²) per month**: decimal for **reconcilability** (the dashboard renders "36 TB" in decimal SI, so a reader multiplying the figure on screen by the quoted $/TB has to land on the number the card shows), and per *TB* rather than per GB because every rate then lands in plain dollars — $23.00, $6.95, $1.10 — instead of the sub-cent GB figures that needed a dedicated formatter to avoid rounding the cluster's own row to "$0.00". That formatter is gone; `formatUsd` covers all of it.
- **The replication factor is a term in the arithmetic, taken from the live layout.** `garageUsdPerGbMonth(usdPerRawTb, years, rf)` multiplies by RF, because at RF 3 a terabyte of a user's data occupies three terabytes of disk — omitting it understates the cluster's cost, and overstates the saving, by exactly 3×. It is clamped to a floor of 1 like `nodeUsableGbFrom` does, so an unreadable RF can never make the cluster look cheaper than it is. The cluster-wide figure divides capacity by RF (`clusterUsableBytes`) and then prices it at the RF-inclusive rate, which must equal pricing the raw disk at the raw price — [rates.test.ts](../webapp/src/lib/pricing/rates.test.ts) asserts that identity, since it is what catches RF being applied twice or not at all. Pricing raw declared capacity against a provider would overstate the cluster's cloud-equivalent value, because their price already includes their own redundancy.
- **Egress is modelled, at one twelfth of the footprint per month** (`EGRESS_FRACTION_PER_MONTH`) — the assumption that a user reads everything back once a year. It is an assumption, not a measurement: this app has no egress telemetry of any kind, so the card states it in visible copy. It is also the conservative end, since egress is exactly where the commercial gap widens. Both free-allowance shapes are real and are not interchangeable — S3 gives a flat 100 GB/month, B2 gives 3× what you store — so modelling only the flat kind would bill B2 for egress it does not charge for. At this volume B2's egress is free and S3's is $261/month on a 36 TB claim, which is most of why S3 reads 27× rather than 21×.
- **Two providers, not three.** One premium (S3) and one budget (B2) bracket the market; a second budget row said nothing the first had not.
- **The headline quotes the *cheapest* alternative, not the dearest.** A saving is only worth as much as the alternative it is measured against, and the dearest one is the easiest to beat — so each section leads with B2 (~6.3× on a 36 TB quota) and S3's much larger saving (~27.5×) waits inside `View details`, where a reader who opens it finds a bigger number they were not sold. `cheapestAlternative(rows)` picks it from the **priced rows**, never from the rate table, because the free-egress allowances differ in shape (a flat 100 GB against a multiple of what you store) and the cheapest storage rate is therefore not automatically the cheapest total; deriving it makes "the headline is the conservative comparison" true by construction rather than by coincidence. The summary band's phone-only row uses the same helper — that is one function, not two, precisely so the two surfaces cannot disagree about which comparison is honest. `HEADLINE_RATE` remains for the **static** no-quota copy, is likewise the cheapest reference rather than a hardcoded key, and a test asserts the constant and the helper agree across footprints.
- **It is a marketing panel, not a spreadsheet.** One headline, three labelled bars, one line of assumptions. An earlier cut carried a rate column, a monthly column, an annual column, a cheapest-provider sentence and a five-line footnote — every figure defensible and the whole thing unreadable beside working controls. Detail lives in the per-row tooltip, where it costs nothing until asked for. A test asserts there is no `<table>`.
- **The cluster line says "can hold", never "replaces".** Usable capacity supports a *capacity* claim, not a *spend* claim — the app has no cluster-wide stored-bytes figure (`Buckets.bytes` needs a superuser aggregate, and `diskTotal − diskFree` is filesystem used, which triple-counts replicas). A test asserts the wording.
- **Every named provider carries its actual published rate.** An earlier cut used an invented "blended cloud" rate of $0.20/GB/month — ~8.7× S3's list price — which had to be labelled generically precisely because attributing it to anyone would have been false. Using the real numbers (S3 Standard $0.023/GB, Wasabi $7.99/TB, Backblaze B2 $6.95/TB, all checked `RATES_AS_OF`) removed the need for the fiction, and the comparison still holds comfortably. **Do not reintroduce a made-up rate to widen the gap.** A unit test pins each figure and a render test pins the labels beside them.
- **The assumptions are visible copy, not a tooltip.** Read `$22/TB` as a *monthly* rate rather than amortized capital and it becomes $0.022/GB/month — dearer than Backblaze, and the whole ranking inverts. That sentence is the card's most load-bearing text. The footnote also states that egress and requests are unmodelled, that power and operator time are excluded, the decimal-TB basis, and `RATES_AS_OF` (rendered from the constant so copy and numbers cannot drift).
- **The config fetch is its own effect, never part of `loadData`.** A failure inside `loadData`'s `Promise.all` sets `error` and the whole dashboard renders as an error string; a cosmetic panel must not be able to do that. `usePricingConfig()` also **never reports null** — it starts at and falls back to the built-in defaults, so a failed fetch costs the reader an accurate hardware cost rather than the panel.
- **`/next-api/config/pricing` is a sibling of `/next-api/config`, not part of it.** That route 500s deliberately when `GARAGE_S3_ENDPOINT` is unset; folding pricing in would blank the card on any deployment with no S3 gateway. A separate route file inherits none of the parent's failure behaviour.
- **No new API calls on the dashboard.** `capacity` and `replicationFactor` were already on the wire from `/cluster/nodes` and being discarded by a narrowed local type.

#### Node identity

A node is identified by its **name**, or — when it has none — by its **node key**: the first 16 characters of its Garage node id, bare, exactly as `garage status` prints them in its `ID` column (`1f104208aab74215`). Those are the only two forms, and **hostname is not one of them**. All of it lives in [webapp/src/lib/node-label.ts](../webapp/src/lib/node-label.ts), which (like `units.ts`, `ledger-math.ts` and `object-cap.ts`) is deliberately **not** `server-only`: the admin console, the dashboard and the cluster map all label nodes client-side, and a second hand-rolled copy in a component is exactly how this went wrong before — three `nodeLabelFor`s, two inline copies, truncations at 8 and 12 characters, and a hostname fallback that rendered blank on one page and the id on another.

**Garage has no node `name` field.** The layout role's `tags: string[]` is the only operator-settable label, so a name is a tag prefixed `name:` — `["ssd", "name:vault-01", "rack4"]` names the node `vault-01`. Nothing in this app writes tags; operators set them through Garage. `parseNodeTags(tags)` returns `{ name, rest }` as **one** call rather than a name-getter plus a tag-filter, because the two must agree on which tag was consumed or a node's name renders twice — once as its label, once as a badge beside it. A `name:` tag with an empty value is skipped rather than honoured, so a stray one cannot blank a node.

**Names resolve at display time**, never denormalized onto a row. `StorageClaims` and `StorageClaimAudit` already snapshot `node_hostname` at write time and never refresh it (`PATCH /claims/[id]` touches only `quota_gb` and `note`), which is precisely how one node came to show two labels on two pages. Views holding a layout use `buildNodeNameMap(layout.roles)` and look up by `node_id`; a node that has left the layout has no name and falls back to its key, which is the honest answer. That map is **keyed by `nodeKey(role.id)`**, not by the raw role id — the layout comes from Garage carrying full ids while every row looked up against it carries a key, and `presentNodeIdSet` / `nodeUsableGbInLayout` in [ledger-math.ts](../webapp/src/lib/storage/ledger-math.ts) normalise for the same reason. Every comparison in the app is key-to-key. For that reason `NodeClaimPosition` deliberately carries **no** `nodeHostname`, and `ClusterNodeItem` no `hostname` — the columns and the hook writes stay, but nothing projects them to the UI.

A node with an **open manual note** is drawn amber on its card, not green: `nodeStatus()` in [garage-node-card.tsx](../webapp/src/components/cluster/garage-node-card.tsx) takes the worst of liveness and repair — down beats under repair beats unknown beats up — and repair also renders as its own badge, so a node that is both down and being worked on shows the red dot *and* the badge. Liveness alone was the bug: a node someone had filed a repair note against looked identical to a healthy one, which is the exact thing the note exists to say.

`<NodeIdentity>` ([webapp/src/components/cluster/node-identity.tsx](../webapp/src/components/cluster/node-identity.tsx)) is the table treatment: name on top, key beneath in muted mono, and for an unnamed node the key **alone** — never the same string twice. It owns its own typography, so strip `font-mono text-xs` off the enclosing `<TableCell>`. Zone stays an attribute (its own column, the cluster-map grouping, the details-dialog badge) and is deliberately *not* part of any identifier — it came out of the node pickers for that reason.

**The full node id never leaves the server.** It is the credential [`POST /next-api/garage/nodes/owners`](#node-ownership) accepts as proof that you run the machine, so the rule is structural rather than reviewed:

- **PocketBase stores keys, in every collection** — `NodeMetrics`, `ClusterEvents`, `StorageClaims`, `StorageClaimAudit`, `StorageNodeBalances`, `NodeOwners`. [1787500000_shorten_node_ids.js](../pocketbase/pb_migrations/1787500000_shorten_node_ids.js) truncated the existing rows and the scrape has written keys since. **No rule changed**: `NodeMetrics` keeps its open listRule, which is why the cluster map and `/dashboard/metrics` still read PocketBase straight from the browser instead of needing a projecting handler. With nothing to leak, there is nothing to gate.
- **No route handler emits one**, admin routes included — `/cluster/nodes`, `/cluster/status`, `/cluster/layout`, `/repairs`, `/repairs/workers` all reduce to keys. [node-id-boundary.test.ts](../webapp/src/app/next-api/garage/cluster/node-id-boundary.test.ts) asserts it against the whole serialized body with a `/[0-9a-f]{64}/`, so the next handler somebody adds fails without anyone remembering the rule.
- **Nothing renders one.** There used to be a `revealNodeId` prop that showed the full id to admins on `/admin/cluster`; it was deleted rather than re-plumbed through an admin-gated reveal route. An admin who needs a full id reads it from `garage status`, which is where it comes from. A render site that exists is one that can end up on the wrong page. (The node card's `aria-label` likewise uses the rendered label, not the id — an aria-label is a display surface too.)
- **The one exception is input, not output**: the claim form on `/dashboard/nodes` — rendered only where `FEATURE_NODE_CLAIMS` is on — where an operator pastes what `garage node id` printed. `<id>@<addr>` is accepted and split, since that is the form the command emits. `/admin/nodes` is *not* a second exception — it submits the key it already holds, and the route admits that from an admin; see [Node ownership](#node-ownership).

**Going back the other way is server-side only.** Garage's `?node=` parameter is documented on all twelve on-node operations as "Node ID to query, or `*`, or `self`" — `required: true`, no `pattern`, no partial-match variant; where Garage *does* take a partial identifier it says so on a separate parameter (`GetKeyInfo`'s `search`, "Partial key ID or name to search for") and it does not do that for `node`. So a key must never go on the wire: [repair.ts](../webapp/src/lib/garage/repair.ts) sends a string and then looks the **same string** back up as a key of the multi-node envelope, and refuses to fuzzy-match if the two disagree — send a prefix Garage resolves but answers by full id and every repair reads as a failure that actually ran. [webapp/src/lib/garage/node-resolve.ts](../webapp/src/lib/garage/node-resolve.ts) is the only place a key becomes an id: `resolveNodeKey` for a key, `resolveNodeIdentifier` for CLI parity (full id, key, or a `name:` tag). Both **409 on ambiguity rather than picking a match** — that needs a 64-bit collision, so if it happens something is wrong in a way that choosing one of them would bury. It is not exported from the `lib/garage` barrel, on purpose, like `cached.ts`; and the layout it is handed must be a **live** read, since every caller is performing an action.

Truncating to a prefix rather than hashing to a surrogate is the deliberate choice, replacing the `node_ref = HMAC(node_id)` this section used to propose: it matches what the CLI prints so an operator recognises it, it stays a valid prefix of the id so the server can resolve it back, and it gives nothing away — 192 bits of the id remain unknown, which is also why the claim route needs no rate limiter.

`/dashboard/metrics` is the one page that never *fetches* the layout for its data. Its rows do carry layout-derived numbers — `stored_partitions` / `partition_size_bytes`, snapshotted at scrape time — but no tags, so there is still nowhere on that page to get a node's name from. It therefore fetches `/next-api/garage/cluster/nodes` alongside its history and **lets that call fail** (`.catch(() => null)`, degrading to node keys). Enriching the metrics route server-side would have turned an unreachable Garage into a 500 on the page an operator opens *because* the cluster looks sick — and the missing-data banner deliberately does not depend on it at all, since its numbers arrived through the scrape and are already in PB.

#### Node data coverage

A node whose data drive is replaced rejoins reporting **healthy**: `isUp` is true, it is connected, and `GetClusterHealth`'s `partitionsAllOk` stays at 256/256 — that number is derived from *connectivity*, not from stored bytes. [webapp/src/lib/metrics/data-coverage.ts](../webapp/src/lib/metrics/data-coverage.ts) is the missing number, and `/dashboard/metrics` is the only consumer (a "Data per partition" chart plus a flagged-nodes banner). Detection only: no repair action, and — a known deferral, not an oversight — no cluster-map or node-details treatment, so `/dashboard/cluster` and `/admin/cluster` still show a flagged node as perfectly healthy.

**The invariant it rests on:** a stored partition holds one full replica of that partition's data, whatever the reason it was assigned. Heterogeneous drive sizes and zone-redundancy constraints change *how many* partitions a node gets, never *how much one partition holds*. So `usedBytes / storedPartitions` is near-uniform across healthy storage nodes, and a node well below the pack is a node missing data. Garage exposes no per-node "bytes I own", so this is inherently **comparative**.

- **Median, never mean.** The estimator has to survive the outlier it is looking for: with 3 nodes and one wiped, a mean falls to ⅔ of normal, so the broken node reads a 33% shortfall instead of ~100% — it masks itself and drags its peers toward the bar. The node's own value is included (no leave-one-out, which at n=3 reduces to a mean-of-two).
- **Three linked ratios,** since `bytesPerPartition = entriesPerPartition × bytesPerEntry` exactly. Bytes per partition is what is on disk per unit of ring; **rc entries** per partition is how many blocks the node's *metadata* claims; **bytes per claimed block** is how many bytes it actually holds for each one. Metadata converges on the fast table-sync path, block data on the slow resync path — so "rc normal, bytes low" is the fingerprint of a wiped drive with intact metadata, and it is what separates `missing-data` from `rebuilding`.
- **Both byte axes gate; `dataShortfallPct` is the larger.** Bytes-per-claimed-block is the sharper answer to "is the stored data short", because it is immune to partition-assignment skew — blocks are content-addressed and hash-distributed, so their average size is identical across nodes in expectation, and at millions of blocks per node that holds tightly in practice. Gating on bytes-per-partition alone is **not** sufficient: a node whose metadata claims *more* blocks than its peers has its byte shortfall arithmetically deflated by that surplus. Measured on the live cluster, exactly that node read 21.3% short on bytes-per-partition and 25.1% on bytes-per-block. `missingBytes` (`rcEntries × (median − own)`) turns the second into the figure an operator wants.
- **Guards and bars, exported as constants so UI copy and tests can't drift:** `MIN_PEER_READINGS` 3 (at n=2 the median is the mean of two, and one broken node makes both read ~50% short — a mutual false accusation), `MIN_MEDIAN_BYTES_PER_PARTITION` 64 MiB (a near-empty cluster where one object swings every ratio), `SHORTFALL_WARN` 0.10, `SHORTFALL_SEVERE` 0.25 (copy only, never gating), `RC_COVERAGE_BEHIND` 0.15. The two bars are **calibrated against measurement, not intuition**: on a live 7-node cluster spanning 24–120 TB and 42–214 partitions, the six healthy nodes sat within −1.1%/+1.9% of the median on bytes-per-partition and −2.2%/+1.9% on bytes-per-block. 10% is ~5× that spread. The original 0.25 was ~11× it and let a node missing ~17 TB read as fine — don't raise it back without a spread measurement that justifies it. The one benign cause of a genuinely low reading is a node compressing or deduplicating differently from its peers (one ZFS node in an ext4 cluster), which is an operator inconsistency worth surfacing anyway. When a guard fires, every contributor comes back `unknown` with that reason and `ClusterCoverage.guard` is set — the page **must say so** rather than render nothing, because a silent all-clear is the exact failure this feature exists to prevent.
- **It is the data partition only.** `usedBytes` is `data_total_bytes − data_available_bytes`; the metadata partition never enters the measure. That is *filesystem* used, not Garage-owned bytes — no admin endpoint reports the latter — so anything else living on that filesystem inflates the reading. Inflation can only mask a shortfall, never manufacture one, which makes a flagged `dataShortfallPct` a **lower bound** on what is actually missing.
- **The default is fail-loud.** A real shortfall with no stats reading cannot be told apart from a rebuild in progress, so it classifies as `missing-data`, carrying the reason so the UI can hedge. Under-alarming is the failure mode that matters here.
- **One-sided.** `shortfallPct` clamps at 0 below, so an over-full node never alarms. That is what makes draining nodes, capacity reductions, and stray non-Garage files on the data filesystem safe — all push bytes-per-partition *up*. Gateways, draining nodes, and down nodes fall out through the ordered exclusion checks rather than through special cases.

> **Hazard.** `storedPartitions × partitionSize` (Garage's `usableCapacity`) is a *strictly more accurate* answer to "how much of this node is usable" than `nodeUsableGbFrom(capacity, rf)` — it accounts for the zone-redundancy constraints `capacity / replicationFactor` ignores, and will routinely be lower. That is exactly why it is dangerous: the per-node claim invariant is `sum(claim.quota_gb on node) ≤ node.capacity / replicationFactor`, and substituting the better number would silently revalue every node's ceiling downward and could retroactively invalidate existing claims. So the module stays in **bytes**, never GB, so it cannot typecheck into a ledger call site; it lives in `lib/metrics/`, which nothing in the accounting path imports, never `lib/storage/`; and nothing it produces is rendered under a "Capacity" heading. **Display only — changing the claim invariant's denominator is a storage-accounting change, not a metrics change.**

#### Cluster events

`/admin/events` is a dated log of what changed in the cluster and why. It exists because **Garage keeps no history of itself** — no event stream, no webhook, no attribution, and `GetClusterLayoutHistory` (unwrapped) carries per-version node *counts* with no timestamps and no role detail. A change is observable only in the moment two consecutive samples disagree, so the timeline has to be *made*, not read.

**One collection, three authors, and nothing new running.** Detection is folded into the existing `node-metrics-scrape` cron rather than given a cron of its own: that run already fetches everything needed and already writes inside a transaction, so a sample and the events derived from it commit together. No new Garage calls are made at all.

- **The previous observation IS the previous `NodeMetrics` row.** That is what the five columns added in [1786800000_updated_NodeMetrics.js](../pocketbase/pb_migrations/1786800000_updated_NodeMetrics.js) are for (`role_ok`, `role_capacity_bytes`, `node_tags`, `layout_version`, `garage_version`). A second state store would be one more thing to keep in step with the samples it describes.
- **Read before write.** `scrapeOnce` loads the previous window (`PREV_WINDOW_SEC`, 2h — wide enough to ride out a missed tick, narrow enough that a node absent that long is a new observation rather than a diff base) *before* saving this scrape's rows. After the writes, "previous" would be the row just saved. A longer gap emits nothing, which is the honest answer: we weren't looking.
- **`role_ok` is the upgrade guard**, and the thing to understand before touching this. It does not mean "this node has a role" — it means *"this row was written by a scraper that records the role columns"*, and is set whenever `layout_ok` is. Pre-migration rows read `false`, so the detector refuses to diff against them. Without it, the first scrape after the migration would compare every storage node's real capacity against the `0` an absent PB number field reads back as — and `0` is *also* a legitimate gateway reading, so there is no way to tell the two apart from the value alone. **Verify this by hand on a database with existing rows: the first two scrapes after deploying must produce an empty timeline.**
- **`diffObservations` is pure** — no Goja globals, no requires, not even a clock (the caller stamps `occurred_at`, which also keeps every event in one scrape on the same instant). That is what lets [cluster-events-lib.test.ts](../webapp/src/lib/metrics/cluster-events-lib.test.ts) drive it from vitest across the workspace boundary, the same arrangement as `bucketHistory`. Every guard below has a case there.
- **Detection is best-effort and never fails the scrape.** A sample recorded without its events is a small loss; a scrape lost because the differ threw is a hole in the history the charts draw from.

Thirteen kinds — ten detected, plus `note`, `repair` and `node_owner_changed` from the two human authors. The detected ten fall into two families. Layout-derived (`layout_version`, `node_added`, `node_removed`, `capacity_changed`, `tags_changed`) require `role_ok` on **both** rows; status-derived (`node_state`, `disk_changed`, `data_drop`, `version_changed`, `zone_changed`) do not, since they come from `GetClusterStatus`, whose failure aborts the whole scrape anyway. Notes worth keeping:

- **`layout_version` is cluster-scoped** — one row per bump with an empty `node_id`, not one per node, even though the version is denormalized onto every row.
- **`data_drop` compares a node against its peers, not against the cluster.** Including the node under test in the cluster figure deflates the comparison towards suppressing exactly the case it exists to catch: with three nodes and one wiped, the node's own loss is a third of the cluster total. Peer totals are computed over nodes present in **both** scrapes, so a node joining or leaving cannot read as the cluster gaining or losing data. With no peers, nothing contradicts the drop and it is reported.
- **Constants are exported so copy and tests can't drift** from them, as in `data-coverage.ts`: `DISK_CHANGE_TOLERANCE` 0.01 (a filesystem total only moves when the filesystem does), `DATA_DROP_PCT` 0.10, `DATA_DROP_MIN_BYTES` 64 GiB, `CLUSTER_DROP_RATIO` 0.5.
- **Two of the thirteen kinds are conditions, not instants** — see below. The other eleven are edge-triggered and are written closed (`ended_at = occurred_at`) the moment they are written.
- `node_state` is deliberately *presented* as an observed state rather than a precise outage: at 15-minute sampling the timestamps bound each transition to the preceding interval, and the page says so.
- **A node Garage stops listing entirely writes no row**, so the per-node loop can never see it — hence the separate pass over the previous node set that emits `node_removed`.

**Ongoing conditions: one row, opened and closed.** A node going offline used to write `"<key> is not responding"` and, on recovery, a *separate* `"<key> is back online"`. Nothing linked the pair, nothing recorded a duration, and a node flapping across four scrapes cost four rows fifteen minutes apart — at 50 rows to a page, one flapping node filled `/admin/events` and pushed real events off it. The two kinds that describe a **condition** rather than a transition (`ONGOING_KINDS` = `node_state`, `node_removed`) now get a single row that is opened, possibly re-opened, and finally closed.

`ended_at` carries all three states and there is deliberately no status column — the same trade `writeTimelineActionRow` has been making since it was written:

```
ended_at = ""            still open — an unresolved condition
ended_at = occurred_at   an instant: the other eleven kinds, and every `action` row
ended_at > occurred_at   a resolved condition; the pair bounds its duration
```

- **Only these two have an inverse.** A capacity change or a rename has nothing to resolve into — the capacity is simply the new capacity from then on. `node_state` closes when the node answers a scrape again; `node_removed` closes when the node is listed again *with* a role. `data_drop` and a shrinking partition were considered and left out: "the bytes came back" is a judgement call, and a wrong one closes an incident nobody looked at.
- **Opening stays edge-triggered; closing is state-driven, and the asymmetry is the thing to understand here.** Opening on current state ("this node is down and has no open row") would be self-healing, but it would break the property stated above — *the first two scrapes after deploying must produce an empty timeline* — and abandon the "a node with no previous observation produces nothing / we were not looking" rule. Closing on state cannot manufacture anything: it only ever closes a row the detector itself opened. It is also strictly stronger than a rising edge, because it still fires after a cron gap wider than `PREV_WINDOW_SEC`, when there is no edge left to see. The cost is honest: a node already down before this shipped has no open row, so its recovery writes nothing — after the backfill there are no such rows.
- **`conditionActive` has three answers, and the third is why it is a function.** `true` leaves the row open, `false` closes it, `null` means *this scrape cannot tell* and touches nothing. A node absent from the sample is `null` for `node_state` (whether that is an outage or a removal is `node_removed`'s question), and a row with `role_ok` false is `null` for `node_removed` — the same gate the diff applies, because without it a capacity of `0` is indistinguishable from an absent field, and closing on that would announce a node had rejoined the layout because the layout failed to load.
- **`reconcileOngoing` is pure and clockless**, like `diffObservations` and for the same reason. The flap window is not applied inside it: `readOpenConditions` bounds its query by `FLAP_WINDOW_SEC` (1800s, two scrape intervals), so every *closed* row that reaches the function is by construction re-openable. A condition recurring inside that window re-opens its existing row and bumps `occurrence_count` instead of appending another; outside it, Tuesday's outage and Thursday's stay two entries, which is what a reader of a timeline wants them to be.
- **The repeat suppression is one line**: an opening event whose condition already has an open row is dropped. That is what makes a node that stays down cost nothing on every subsequent scrape.
- **A node whose row failed to write is excluded from the removal pass.** It is absent from `current` for a local reason, and reporting it removed was already wrong — it now costs an *open* condition rather than one stray row, so `scrapeOnce` collects the failures and passes them through.
- **`1787800000_close_legacy_events.js` is what makes the rule true of the history**, closing every non-`manual` row that has an empty `ended_at`. Manual rows are excluded because an open note is *legitimately* open — it is the "under repair" marker, set by hand — and closing those would clear that state on every node at once.
- **An admin can close an open detected row but never re-open one.** `PATCH .../[id]` allows `endedAt` on a `detector` row only while `ended_at` is empty, and only to a non-empty value. Some conditions never resolve on their own: a decommissioned node's `node_removed` would sit "in progress" for ever, waiting on an event that cannot happen. Re-opening stays refused because it would let an admin re-write something a machine measured — the detector may still re-open a row it closed itself inside the flap window, which is a recurrence it observed rather than an edit. `action` rows are refused outright; they were never open.

**Open rows reach the cluster map, and the wording splits on `source`.** `ClusterEventMutator.listOpen` replaces `listOpenManual` — `ended_at = ""` now means unresolved across the whole collection, so filtering by source would have hidden every detected outage from the surface that most wants one. The pages split the result themselves: an open `manual` row is **under repair** (a person saying they are on it), an open detector row is **unresolved** (a machine saying nobody is). Calling the second "under repair" would claim an owner it does not have. On a node card the precedence is down > under repair > unresolved > unknown > up, so the commonest unresolved condition — a node that is merely offline — is never the reason a dot is amber.

**`eventStatus()` in [cluster-timeline.ts](../webapp/src/lib/cluster-timeline.ts) is the only reader of the three-state rule**, alongside `STATUS_LABEL` / `STATUS_TONE`, for the reason `CATEGORY_LABELS` moved there. It compares **parsed** timestamps, not strings: the detector writes both halves in PocketBase's `2026-08-11 09:15:00.000Z` form, but a row closed through the API carries a real ISO string, and a string comparison would sort every `T` after every space on the same day. Durations are rendered as two absolute datetimes and never as "open for 4 days" — a relative duration reads the clock during render, which `react-hooks/purity` refuses, as `node-details-dialog.tsx` already documents.

**The coverage shortfall is a suggestion, never a detected row.** The median comparison in [data-coverage.ts](../webapp/src/lib/metrics/data-coverage.ts) is *comparative* and re-decides on every scrape, so writing it would append the same finding every 15 minutes until someone fixed the node. `/admin/events` runs `assessCoverage()` client-side from `fetchLatestNodeMetrics()` (via the new `coverageInputFromMetric`, the raw-row twin of `coverageInputFromPoint`) and offers a **Log this** button that opens the note dialog prefilled. As on `/dashboard/metrics`, when a guard suppressed the judgement the page **must say so** rather than render nothing.

**Manual rows and annotation.** `POST /next-api/garage/events` forces `kind: 'note'` / `source: 'manual'` — a caller cannot file a fabricated observation among the detector's. `PATCH .../[id]` writes **only** `annotation` (+ its `annotated_by` / `annotated_at` stamp) and `ended_at`; the observed fields are not editable on any row, including a manual one, because anything further to say belongs in the annotation where the reader can see it came later. `DELETE` refuses everything but `source: 'manual'` (an allow-list, so a source added later is refused by default). `ended_at` is additionally writable on an *open* `detector` row, once, to close it — see the ongoing-conditions notes above for why that exception exists and why it does not run the other way. All three write through `getPbAsSuperuser()`, since the collection's write rules are `null`; reads use the caller's own `pb` against the admin listRule, like `/claim-audit`.

**"Under repair" is an open manual note**, not a column: any `source: 'manual'` row with a `node_id` and an empty `ended_at` puts that node in that state on the events page and the cluster map, and closing the row clears it. One rule, no extra field, and the dialog's "still ongoing" toggle is the explicit control. An open *detector* row marks its node too, as **unresolved** rather than under repair — see the ongoing-conditions notes above.

**The dashboard timeline.** `/dashboard/cluster` renders the same log below the node map for every signed-in user — the events already existed, they just never reached the people looking at the cluster. `GET /next-api/garage/cluster/events` is that door: `getServerUser`, one memoized superuser read, and each row rebuilt field by field into `ClusterTimelineEvent`. **The projection is the privacy boundary, not the collection rule** — the rules stay admin-only, and `actor_id` / `actor_email` / `annotated_by` never leave the server, along with `detail`, `previous_value`, `new_value` and `annotation`, none of which that page renders. `category` **is** carried, because it is the badge: every manual row has `kind: 'note'`, so labelling one "Note" spends a badge to say nothing — `eventBadgeLabel()` renders a manual row's category and falls back to the kind for a detector row, which has none. It is a closed enum and identifies nobody. Spreading the record would work today and leak the next column somebody adds; every field a user sees is named in the handler. It lives under `cluster/` because that is where the user-facing display family already is (`cluster/nodes` is the other `getServerUser` route there), and because a sibling of `events/[id]` would be a static segment quietly winning over the dynamic one. It is **enrichment**: the page fires it alongside the layout fetch and swallows a failure into one muted line, since a cluster map that refuses to render because its timeline 500'd is the worse trade.

`TIMELINE_DAYS`, the week bucketing, `eventBadgeLabel()` and the `KIND_LABELS` / `CATEGORY_LABELS` / `SEVERITY_TONE` maps all live in [webapp/src/lib/cluster-timeline.ts](../webapp/src/lib/cluster-timeline.ts) — deliberately not `server-only`. `/admin/events` and the log dialog import them rather than keeping the copies they used to own (`CATEGORY_LABELS` existed twice, commented "the same words either side"), for exactly the reason `node-label.ts` exists. Weeks are **local** calendar weeks stepped with `setDate`, so one spanning a DST change is still seven days rather than 167 hours, and **only weeks with something in them get a marker**. An earlier cut drew every week in the window so quiet stretches were explicit; on a real cluster most weeks are quiet, and the result was a column of "No events" with the occasional event in it — the scaffold drowning the thing it framed. The window is stated once in the card's description instead. A note dated in the future — planned maintenance next Tuesday, which the log dialog permits — is shown rather than dropped, but only within one further window: the route bounds its query on **both** ends and the grouping filters to the same bounds, so a note whose year was mistyped can neither be fetched and then quietly discarded nor park itself permanently at the top.

#### Repairs

`/admin/repairs` launches Garage's repair operations per node — a scrub (start,
pause, resume, cancel), a block repair, or a rebalance — and shows what each
node's scrub worker is doing. Three sub-routes under one layout, which is the
app's first nested admin nav; `admin/layout.tsx`'s `pathname.startsWith(href)`
already keeps the parent lit, so that file's logic is untouched.

**Everything on-node goes through one envelope.** Twelve v2 operations take a
required `node` query param (an id, `*`, or `self`) and answer
`{ success: Record<nodeId, T>, error: Record<nodeId, string> }` with **both keys
required**. A 200 means *the coordinator answered*, not *the operation ran*.
[webapp/src/lib/garage/multi-node.ts](../webapp/src/lib/garage/multi-node.ts) is
the only correct way to read one: `NodeOutcome` is a discriminated union, so a
value is unreachable without narrowing on `ok`, and a node id in **both** maps
resolves to a failure. `outcomeForNode` returns **`null`** when the envelope
names the node in neither map — a 200 that means nothing happened, the most
dangerous shape here — and callers must treat it as failure. This module exists
because the repo already made the opposite mistake once, in Goja:
[node-metrics.js](../pocketbase/pb_hooks/lib/node-metrics.js) reads
`(stats && stats.success) || {}` and discards the error map entirely.

**`launchRepair` refuses `*` and `self`, and so does the route.** `*` would fan a
repair across every node while the confirmation dialog named exactly one; `self`
is whichever node answers the admin API, routinely not the one clicked. Two
guards on the same thing is not one too many. The browser also names a
`RepairAction`, never a `RepairType` — the mapping is a total `Record` in
[lib/garage/repair.ts](../webapp/src/lib/garage/repair.ts), so the seven repair
types this app does not offer cannot be requested by editing a body, and adding
an action without deciding what it sends is a compile error.

**There is no last-scrub timestamp in the Garage API.** Not one — no
`lastScrub`, no `ScrubWorkerState`, no `time_last_complete_scrub` anywhere in
v2.3.0. The only channel is `WorkerInfoResp.freeform: string[]`, human prose
Garage may reword between releases, and worker *names* are not in the spec
either. So [lib/repair/scrub-status.ts](../webapp/src/lib/repair/scrub-status.ts)
parses English, and is written to fail safely: keyword-first and never a
whole-line regex, each field matched independently, `Date.parse` as the judge so
an unparseable date is `null` and never `Invalid Date`, the scrub worker found
by a case-insensitive `name.includes('scrub')` with the lowest id winning. Two
rules hold it together — **`freeform` is returned verbatim and the page always
renders it**, so a parse miss costs precision and never information; and
**`recognised: false` is its own UI state**, because "Garage said something we
don't understand" is not "this node has never been scrubbed", and rendering the
two identically is the silent all-clear that `role_ok` and `data-coverage.ts`'s
guards both exist to prevent. When no scrub worker matches, the page names the
workers it did see. **All four scrub buttons stay enabled whenever the node
answered** — deriving which command applies from a freeform-parsed flag would
rest a control on exactly the precision this page admits it lacks. Let Garage
refuse.

**`lib/repair/` is its own directory** for the reason `lib/metrics/` and
`lib/pricing/` are: nothing in the accounting path may import it, and a module
of values scraped out of prose sitting beside `ledger-math.ts` invites a guessed
number into a ledger call site. It is not `server-only` — pages and route
handlers need the same words. Note the deliberate pair:
`lib/garage/repair.ts` is *how to talk to Garage about repairs*, `lib/repair/`
is *what a repair means to this app*, the same split as `lib/cluster-timeline.ts`
against `pb_hooks/lib/cluster-events.js`.

**`GET /next-api/garage/repairs/workers` never reads `cached.ts`.** Worker state
is live operational state; "can this repair run *now*" is not a display
question, the same rule that keeps `/admin/status` off the cache. One fetch
serves all three pages — the scrub page reads `scrub`, the other two read
`busyCount`/`erroredCount`, which is how they can say "something is already
running here" before an operator starts a second multi-day job. It returns no
node identity; that stays with `/cluster/nodes`. **No polling** — `?node=*` fans
out to every peer, and this app has no timer-driven Garage traffic outside the
scrape in the PB process. Manual refresh, plus one after a launch, with
`fetchedAt` on screen.

**`POST /next-api/garage/repairs` writes Garage first and the timeline row
second**, inverting the usual "PB first, Garage second, roll back" rule on
purpose. That rule governs *mirrored* state; a timeline row is the record that a
human pressed a button and there is nothing to roll back to. Garage has to go
first because the row's content depends on the outcome, and a row written
beforehand could only be corrected afterwards — which the collection forbids
(`updateRule: null`). **A refused launch writes a row too**, at `warning`, with
Garage's message in `detail`. **A PocketBase failure logs and still returns
success**: the repair has already run on the cluster, and failing the request
would tell the operator it hadn't, so they would click again and duplicate a
cluster-wide block repair — the `StorageInvites` email precedent exactly.
`logged: false` says so instead. A per-node error or a `null` outcome is a
**502**, never a 200 with `ok: false`, which would rebuild Garage's own trap at
our boundary. It makes **no layout call**: Garage's error map is the authority
on whether the node exists.

**Repair rows reach `/dashboard/cluster`** through the existing
`toTimelineEvent` projection, which strips the actor and `detail`. That is
intended — the events already existed, they just never reached the people
looking at the cluster. Two consequences: **titles carry no node name**
(`'Scrub started'`, not `` `Scrub started on ${label}` ``), because the timeline
resolves names live from the layout via `<NodeIdentity>` and this repo never
denormalizes one onto a row; and a repeatedly failing button would flood that
timeline, bounded by the typed confirmation and the route's 200-row cap.

**The gate is a type-the-node-name challenge**, not an OTP: the question is *did
you mean this node*, which an OTP does nothing about. It is a React boolean and
**not server-enforced**, like every other gate here. `ConfirmDeleteDialog` grew
`variant` / `pendingLabel` (defaulting to the delete behaviour, so no call site
changed) and a `useId` — as it was, "Start scrub" rendered a red button reading
"Deleting...", and a table of N rows put N inputs with the same DOM id on the
page.

**`DELETE /next-api/garage/events/[id]` is now an allow-list** (`source !==
'manual'` → 409) rather than a deny-list on `'detector'`. The old form silently
admitted every source added after it, and the first one added was `action` — the
row recording that a named admin launched a cluster-wide repair, which is
precisely the row that admin must not be able to delete. `PATCH` likewise
refuses `endedAt` on a non-manual row; annotation stays open to every source.

### Admin gate

Admin checks use the `Admins` collection rules: the listRule/viewRule (`@collection.Admins.user ?= @request.auth.id`) means a non-admin querying their own row gets a 404 and an admin gets the record. So [webapp/src/lib/auth/server.ts](../webapp/src/lib/auth/server.ts) `isUserAdmin()` and the client-side [webapp/src/hooks/use-admin-status.ts](../webapp/src/hooks/use-admin-status.ts) both work via the same self-scoped lookup, no superuser auth needed.

`getPbAsSuperuser()` from [webapp/src/lib/auth/server.ts](../webapp/src/lib/auth/server.ts) authenticates as a PB superuser when a Route Handler needs to bypass collection rules (e.g. updating fields the caller's `updateRule` doesn't permit). After the migration that opened Users list/view to admins, most admin reads no longer need this — but it remains the escape hatch for trusted writes.

### Garage client

[webapp/src/lib/garage/](../webapp/src/lib/garage/) wraps the [Garage admin API v2](https://garagehq.deuxfleurs.fr/api/garage-admin-v2.html). Every file starts with `import 'server-only'`. Every Garage response is parsed through a zod schema in [webapp/src/lib/garage/schemas.ts](../webapp/src/lib/garage/schemas.ts) — Garage v2 is "early implementation, may change", so the schema layer protects us against drift. Errors map to typed classes (`GarageNotFoundError`, `GarageQuorumError`, `GarageAuthError`, `GarageValidationError`) in [errors.ts](../webapp/src/lib/garage/errors.ts).

Tests for the client are in [webapp/src/lib/garage/garage-client.test.ts](../webapp/src/lib/garage/garage-client.test.ts) — they mock `globalThis.fetch`. The vitest config aliases `server-only` to a stub ([webapp/src/test/server-only-stub.ts](../webapp/src/test/server-only-stub.ts)) so server modules are importable from tests.

## Key invariants

- **Client-side PocketBase only.** Don't call PocketBase from a Server Component. Server-side PB instances exist only inside `/next-api/garage/*` Route Handlers — and only to verify the caller's auth token (`authRefresh`) or perform privileged admin operations as a superuser. Rationale: [docs/PB_SSR.md](../docs/PB_SSR.md).
- **Garage client is server-only.** The bearer token must never reach the browser. Anything under `webapp/src/lib/garage/` is `import 'server-only'`. Browsers reach Garage exclusively via `/next-api/garage/*` proxies.
- **Mutators, not raw SDK** for PB reads. Data access goes through a `BaseMutator` subclass (see [shared/src/mutators/base.ts](../shared/src/mutators/base.ts)) — handles zod validation, default expand/filter/sort, error wrapping, realtime subscriptions. Direct `pb.collection('...').create(...)` calls are a smell for read paths; mutations on `AccessKeys`/`Buckets` go through Route Handlers and may use the typed PB client directly there since the validation already happened above.
- **Mutators live in `shared/`**, exposed via `@garage-ware/shared/mutators`.
- **`TypedPocketBase` is duplicated.** [webapp/src/lib/types.ts](../webapp/src/lib/types.ts) defines a webapp-local `TypedPocketBase` to avoid type drift between the webapp's `pocketbase` package and shared's. When wiring a new collection into the typed client, update **that** file's overload list, not just shared's.
- **Schema → migration → restart.** After editing a `defineCollection()` in `shared/src/schema/`: rebuild shared, run `yarn db:migrate`, review the generated file, then restart PocketBase (it auto-applies on startup).

## Adding a collection

1. Create `shared/src/schema/<name>.ts` using `defineCollection()` + zod field helpers from `pocketbase-zod-schema` (`TextField`, `RelationField`, `BoolField`, `NumberField`, etc.). Export the collection, the `Schema`, the `InputSchema`, and inferred types. See existing schemas (`user.ts`, `admin.ts`, `access-key.ts`, `bucket.ts`) for the pattern, or `storage-claim.ts` / `storage-transfer.ts` for an append-only ledger (deliberately non-unique index; transfers also set `updateRule: null`, since a handoff is corrected by deleting it, not editing it). `storage-claim-audit.ts` is the pattern for a hook-written, API-immutable log: all write rules `null`, `SelectField` for closed enums, and plain `TextField` in place of relations so rows outlive what they describe. `cluster-event.ts` is the same pattern where a *human* also writes: the rules stay `null` and the route handlers write as a superuser, rather than opening create/update to admins.
2. Re-export from [shared/src/schema.ts](../shared/src/schema.ts).
3. Create `shared/src/mutators/<name>.ts` extending `BaseMutator<T, TInput>` — implement `getCollection()` and `validateInput()`. Re-export from [shared/src/mutators/index.ts](../shared/src/mutators/index.ts).
4. Add a collection overload in [webapp/src/lib/types.ts](../webapp/src/lib/types.ts).
5. `yarn workspace @garage-ware/shared build && yarn db:migrate`, review the migration, restart PocketBase.

### Migration ordering caveat

`pocketbase-migrate` emits one file per collection, timestamped at generation time. If a new collection's rule references another collection (e.g. `@collection.Admins.user ?= @request.auth.id`), the referenced collection must be created **first** — PocketBase validates rules at collection-save time and will reject a forward reference. After `yarn db:migrate`, check the generated filenames and rename them so timestamps order dependencies correctly. The current migrations show the pattern: `1778036285_created_Admins.js` runs before `1778036286_created_AccessKeys.js` and `1778036287_created_Buckets.js`.

**`yarn db:migrate` currently cannot generate at all.** The tool replays every prior migration in a plain JS sandbox to rebuild a snapshot, and [1786122444_created_StorageUserBalances.js](../pocketbase/pb_migrations/1786122444_created_StorageUserBalances.js) calls `require` — a Goja global that only exists inside PocketBase. It fails with `ReferenceError: require is not defined` before reaching your schema change. Until that backfill is reworked, hand-write the migration following the shape of an existing one; [1786200000_updated_Buckets.js](../pocketbase/pb_migrations/1786200000_updated_Buckets.js) (adding `object_quota`) is the worked example for a plain additive field, and notes why it sets `onlyInt`/`max` up front. [1786900000_created_ClusterEvents.js](../pocketbase/pb_migrations/1786900000_created_ClusterEvents.js) and [1786300000_created_StorageInvites.js](../pocketbase/pb_migrations/1786300000_created_StorageInvites.js) are the worked examples for a whole new collection — note the `pb_`-prefixed 15-character collection id, and the `select` / `date` / `autodate` field shapes the generator would otherwise have supplied. Verify by restarting PocketBase and reading the collection back from `/api/collections/<Name>`.

**Generated migrations are a starting point, not gospel.** Hand-editing one is normal when the generator can't express the change — [1785361304_updated_StorageClaims.js](../pocketbase/pb_migrations/1785361304_updated_StorageClaims.js) (the append-only-ledger conversion) is the worked example: it splits one schema diff into ordered `app.save()` steps because the replacement index reuses the name `idx_storageclaims_user_node` and PocketBase rejects a collection holding two indexes with the same name, so the drop must land before the add. It also documents in its `down` that reverting can't succeed against existing ledger data without collapsing each `(user, node)` pair first. Read the generated file before trusting it, and leave that kind of note behind.

## Adding a /next-api/garage/* Route Handler

1. Create `webapp/src/app/next-api/garage/<...>/route.ts` exporting `GET`/`POST`/etc.
2. Start with `await getServerUser(req)` (any authenticated caller) or `await requireAdmin(req)` (admin-only). For ownership checks: load the PB row and compare `record.user !== user.id` then fall back to `isUserAdmin(pb, user.id)`. All three helpers are in [webapp/src/lib/auth/server.ts](../webapp/src/lib/auth/server.ts).
3. Build a Garage client via `GarageClient.fromEnv()` and call the relevant module under `lib/garage/` (`cluster`, `keys`, `buckets`, `permissions`). Claim/transfer handlers touch no Garage state except the layout — they call `loadClaimContext(garage)` or `cluster.getLayout(garage)` purely to value capacity. **If the handler only displays cluster state, import `@/lib/garage/cached` instead** (`getCachedLayout` etc. — not exported from the `lib/garage` barrel, on purpose). If it validates anything, keep it live; see [Cluster read cache](#cluster-read-cache).
4. For mutations: write PB first, call Garage second; on Garage failure, roll back the PB row (and vice versa for deletes — Garage first, PB second). Use `try { ... } catch (err) { return errorResponse(err); }` to map `HttpError`/`GarageError` to JSON responses.
5. **Writes to `AccessKeys`, `Buckets`, `StorageClaims`, `NodeOwners`, `ClusterEvents` or the balance collections need `getPbAsSuperuser()`** — their write rules are `null`, so the caller's own client cannot write them. It is memoized, so asking for it costs nothing. Reads still go through the caller's client, which is what makes the self-or-admin listRules do the authorization for you.
6. From the client, call via `api()` from [webapp/src/lib/api-client.ts](../webapp/src/lib/api-client.ts) — it auto-attaches the PB token as a bearer header. Don't write a bare `fetch()`.

## First run and setup

A fresh container used to start three processes and stop there. Every step after
that was manual, undocumented, or broken: nothing created the PocketBase
superuser, `POCKETBASE_ADMIN_EMAIL`/`PASSWORD` were required at runtime but
absent from the Docker docs, there was **no in-app path to the first app admin**
at all (`Admins.createRule` requires you to already be one, and `seed-admin.mjs`
was never copied into the image), and the documented `yarn workspace
@garage-ware/pb admin` ran `./pocketbase admin` — a command removed in
PocketBase 0.23+.

Three pieces now close that, and the split between them matters.

**[docker/entrypoint.sh](../docker/entrypoint.sh) owns everything that must happen
before anything listens.** It resolves superuser credentials (operator env wins;
otherwise generate once and persist to `/data/pb_superuser.env` 0600 — setting
exactly one of the pair is a hard error, not a partial config), runs `pocketbase
superuser upsert` against `--dir` with `--automigrate` doing the schema, and
`export`s the pair so supervisord's children — both PocketBase and Next.js —
inherit them. **No `--hooksDir` on that upsert**: loading the hooks would
register their crons inside a one-shot command. Creating the superuser here also
suppresses PocketBase's built-in installer, which prints a `0.0.0.0:8090` URL
unreachable from a browser behind the container's nginx.

**The claim token is the bootstrap, and the `Admins` count is the guard.** The
entrypoint mints a token, persists it under `SETUP_STATE_DIR` (`/data/setup`),
and prints it; `POST /next-api/setup/claim` takes it from a signed-in caller and
writes the `Admins` row as a superuser. The load-bearing check is
`evaluateClaim` refusing on **any non-empty `Admins`** — checked *before* the
token, so a claimed instance answers identically whether or not the caller
guessed right. The token proves you can read this deployment's logs; the count
is what makes it single-use in effect. `SETUP_OWNER_EMAIL` is the unattended
alternative (a `Users` after-create hook), guarded on the same empty-`Admins`
condition so it is not a standing back door. `GET /next-api/setup/status` is
unauthenticated by necessity — `/` and `/setup` must route a visitor with no
account — and is deliberately confined to four fields; it also **heals the
upgrade path**, writing the `claimed` marker when it finds admins but no marker,
so an existing deployment stops printing a claim banner after one page load.

**Sign-up gating is a PocketBase hook, not a rule and not a route.** Sign-up is a
direct client-side PB call (`AuthService.register` → `UserMutator`), so nothing
server-side of ours is on that path; and `SIGNUP_MODE` is env-driven, so a
collection rule would mean a migration per change. `Users.createRule` therefore
stays `''` and
[pb_hooks/lib/signup-gate.js](../pocketbase/pb_hooks/lib/signup-gate.js) decides.
That file is **pure** — no Goja globals, no `require`, no clock — so vitest
drives it across the workspace boundary exactly as `cluster-events-lib.test.ts`
drives `diffObservations`; `main.pb.js` does the I/O and throws
`BadRequestError`. Four rules, in order: `e.hasSuperuserAuth()` always passes
(that is the admin-invite path in `next-api/garage/users/route.ts`, which has
already done its own check); an **empty `Admins` always passes**, because a
closed fresh install would lock out its own owner before they could claim it;
then `open`/`closed`; then invite mode, which admits `SETUP_OWNER_EMAIL` or a
pending `StorageInvites` row. An unset or unrecognised `SIGNUP_MODE` falls back
to `closed` (the default), **never `open`** — sign-up is off unless an operator
explicitly enables it, and a typo must not throw the doors open.
[signup-mode.ts](../webapp/src/lib/setup/signup-mode.ts) parses the same values for
display, and a test asserts the two parsers agree.

> **Closed-by-default shipped as a breaking change** (`feat!:`): the default
> was `invite` before, so a deployment upgrading into this needs
> `SIGNUP_MODE=invite` or `open` as the one-line opt-out. The UI hides signup
> surfaces to match: promotional links (home, nav, login form) render only when
> the mode is `open` — read via `useSetupStatus()` in
> [use-setup-status.ts](../webapp/src/lib/setup/use-setup-status.ts), seeded
> fail-safe at `closed` — and `/signup` shows a closed-state card on a claimed
> `closed` instance while still rendering the form in `invite` mode, since
> invite emails deep-link there.
>
> **Accepted gap:** while `Admins` is empty, sign-up is open regardless of mode.
> Signing up in that window grants nothing — claiming still needs the token.

**The bootstrap window must never recur, hence the last-admin guard.** Every
relaxation above keys off `Admins` being *empty*, not off a one-time "has this
been claimed" — so an instance that loses its last admin silently reverts to a
fresh install: public sign-up reopens, `SETUP_OWNER_EMAIL` re-arms,
`/next-api/status` reopens to any signed-in user, and `/` starts sending
visitors to `/setup`. Getting there is easy: `Admins.deleteRule` asks *"is the
caller an admin"*, not *"is this your own row"*, and `Admins.user` cascades from
`Users`, so one self-delete from `/profile` does it. Two `onRecordDeleteRequest`
hooks refuse the last removal — one on `Admins`, one on `Users` for the cascade
path, which fires no `Admins` hook. Both fail **closed** if they cannot count.
Keeping one admin alive is a smaller guarantee than making the window one-way,
and it means the state those relaxations describe simply never comes back.

### Status and troubleshooting

`/admin/status` (`GET /next-api/status`) is the deployment self-check. Everything
it reports previously failed silently in a log nobody reads.

Its gate is `requireAdminOrUnclaimed` — `requireAdmin`, except while **no admin
exists**, when any signed-in caller may read it. That exception is the point: an
owner has to be able to see *why* Garage is unreachable before they can become an
admin. It fails **closed** if it cannot determine the admin count.

Two rules for anything added here:

- **Never read `cached.ts`.** Every Garage call is live. `cached.ts` is designed
  to serve a stale layout straight through an outage, which is the correct
  behaviour for a display path and precisely the wrong answer for "can this
  deployment reach the cluster *now*".
- **Never render a secret.** Env vars report `set`/`unset`; URLs report host only
  via `hostOf()` — which also drops any userinfo, so a URL carrying credentials
  cannot leak through it. The copy-diagnostics block is a pure formatting pass over the
  same payload — if a value is unsafe to paste into a support thread it must not
  be in the payload either.
- **Never take the request's host from `req.url`.** Next.js builds a Route
  Handler's absolute URL from the server's own bind address, so under the
  container's `next start --hostname 0.0.0.0 --port 3000` every request reads
  back as `0.0.0.0:3000` whatever the browser typed — which made
  `app-public-url` warn on every Docker deployment, correctly configured or not.
  A signal that is always red teaches an operator to ignore the page it lives
  on, so this is a worse failure than not checking at all.
  [public-url.ts](../webapp/src/lib/setup/public-url.ts) reads `X-Forwarded-Host`
  then `Host` instead, and compares with a default port for the scheme stripped,
  since a browser omits `:443` and `APP_PUBLIC_URL` is written with one. Both
  headers are client-supplied and neither is authorization — this decides a line
  of advisory copy.

`GET /next-api/health` is separate and unauthenticated: `{status, pocketbase}`,
no Garage, no config detail, 503 when PocketBase is unreachable. It is what the
image's `HEALTHCHECK` hits — nginx's `/health` proxies straight to PocketBase and
so only ever proved the half that rarely dies.

**Garage failures had to be made legible first.** `client.ts` discarded
`err.cause`, so a refused port, a bad hostname and a timeout all reached the UI
as undici's `TypeError: fetch failed`; `fromEnv()` threw a bare `Error`, leaking
its internal sentence into a browser banner as a 500; and nothing outside
`lib/garage/` ever `instanceof`-checked the five error classes. Now
`GarageError` carries a `code` (`classifyFetchFailure` walks the cause chain,
loop-guarded), `GarageConfigError` names the missing vars, and `errorResponse()`
maps them to real statuses — 503 unreachable/quorum/not-configured, 502
auth/schema. That last change fixes all 26 `fromEnv()` call sites at once and
revives the dead 503 branch at `dashboard/metrics/page.tsx:488`, which was
unreachable because the scrape hook's deliberate 503 (`main.pb.js:670`) arrived
as a PocketBase `ClientResponseError` and got flattened to a 500.

## Docker

[docker/Dockerfile](../docker/Dockerfile) builds a single container with Supervisor running PocketBase + Next.js + Nginx (reverse proxy on :80), fronted by [docker/entrypoint.sh](../docker/entrypoint.sh) — see [First run and setup](#first-run-and-setup) for what that does before supervisord starts. All runtime state lives under a single `/data` volume — back up by snapshotting that one directory, which now also holds the generated superuser password and the first-run claim state. [docker-compose.yml](../docker-compose.yml) + [.env.docker.example](../.env.docker.example) are the supported install path. See [docker/README.md](../docker/README.md). Garage itself runs separately; the container only needs to reach `GARAGE_ADMIN_URL` over the network.

**The builder stage mirrors the repo layout; only the runner renames `pocketbase/` to `pb/`.** `next build` type-checks `webapp/src/lib/metrics/node-metrics-lib.test.ts`, which imports `../../../../pocketbase/pb_hooks/lib/node-metrics.js` across the workspace boundary — staging the hooks straight to `pb/` in the builder made that a TS2307 and failed the image build while `yarn build` stayed green locally. The runtime path `/app/pb` is baked into [docker/supervisord.conf](../docker/supervisord.conf), so the rename has to happen, just later. [.dockerignore](../.dockerignore) keeps the host's `node_modules`, `.next`, `pb_data`, and host-arch `pocketbase/pocketbase` out of the context — CI checkouts have none of these, so a build that only ever ran in CI won't tell you they're a problem.

Nginx routing inside the container:

| Path | Backend |
|---|---|
| `/` | Next.js :3000 |
| `/api/` | PocketBase :8090 (API) |
| `/_/` | PocketBase :8090 (admin UI) |
| `/health` | PocketBase health probe |

In Docker, build with `NEXT_PUBLIC_POCKETBASE_URL=/` (same-origin) — the PB JS SDK appends `/api/...` to the base URL itself, and nginx proxies that prefix through to PocketBase, so `/api` here would resolve to `/api/api/...`. That `/` is the Dockerfile default and what [docker-build.yml](../.github/workflows/docker-build.yml) passes. For local dev, use `http://localhost:8090`.

## Notes

[docs/](../docs/) is vendored upstream reference material, not docs about this app — `PB_*.md` for PocketBase (auth, hooks, crons, filters, realtime, SSR) and `GarageHQ_*` for the cluster, including the full [admin API OpenAPI spec](../docs/GarageHQ_OPENAPI.json). Check there before guessing at a PB rule syntax or a Garage endpoint shape; the one file that *is* about this app's design is [docs/PB_SSR.md](../docs/PB_SSR.md).

PocketBase's JSVM typings only exist at `pocketbase/pb_data/types.d.ts`, which the binary writes on first start — so hook signatures can't be checked until you've run PB once. `yarn setup && yarn workspace @garage-ware/pb dev` gets you the file; grep it before trusting any remembered hook API, since v0.23 reshaped all of them.

They reach the hook sources through [pocketbase/jsconfig.json](../pocketbase/jsconfig.json), **not** a `/// <reference path=... />` line in each file, and re-adding one breaks the build: `pb_data/` is gitignored, `webapp/src/lib/metrics/node-metrics-lib.test.ts` imports `pb_hooks/lib/node-metrics.js` across the workspace boundary, and a dangling reference in a file the webapp's TS program loads fails `next build` with TS6053 on any checkout that has never run PocketBase — which is every CI run. `yarn check:refs` ([scripts/check-tracked-inputs.mjs](../scripts/check-tracked-inputs.mjs), first step of `yarn precommit`) is the guard: it fails when a tracked file references or relatively imports a path git doesn't track. `pb_migrations/` is exempt — the generator writes that header itself, and nothing ever imports a migration.

ESLint config at the repo root ignores `pocketbase/**` and `scripts/**` ([eslint.config.mjs](../eslint.config.mjs)). The lint rule `react-hooks/set-state-in-effect` is enabled and strict — define an inner async function inside `useEffect`, do all `setState` calls inside its async callbacks (with a `cancelled` flag) rather than in the effect body or in helpers called synchronously from it. See [webapp/src/app/dashboard/buckets/page.tsx](../webapp/src/app/dashboard/buckets/page.tsx) for the canonical pattern.
