# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

**Rules live here; the reasoning lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).** Every
`→ docs/ARCHITECTURE.md#x` pointer below leads to the full account of why a boundary is where it
is and what broke when it wasn't. Read the linked section before changing anything marked
load-bearing — the short rule here is not enough to re-derive the design from.

## What this app is

`garage-ware` is the management/control plane for a self-hosted [Garage HQ](https://garagehq.deuxfleurs.fr/)
S3-compatible cluster:

1. **Cluster administration** — live status/health/layout/nodes (`/admin/cluster`).
2. **Storage claims** — admins (and node owners) grant users storage per node as an append-only
   ledger of signed adjustments; users slice their total into per-bucket quotas.
3. **Storage transfers** — a user hands part of their *unallocated* claim to another by email;
   an address with no account gets a **StorageInvite** held in escrow instead.
4. **Self-service** — users manage S3 access keys, buckets, per-key permissions, live usage.
5. **Repairs** — admins launch per-node scrub / block repair / rebalance (`/admin/repairs`).
6. **Cluster event timeline** — dated log of what changed and why (`/admin/events`; redacted
   projection on `/dashboard/cluster`).

The one formula to keep in your head — a user's **net granted GB**:

```
netGranted = sum(claims on nodes still in the layout) + sum(transfers received) − sum(transfers sent)
available  = netGranted − sum(bucket.quota_gb)              # what they may still allocate
```

Never hand-roll it. Server-side, read `getUserPosition()` / `getUserStorageSummary()`.

**Source-of-truth split.** Garage owns buckets, keys, layout and usage. PocketBase owns identity,
the Garage↔user mappings, and the two claim ledgers (which have no Garage counterpart). PB does
**not** mirror Garage state — with four deliberate exceptions: the `Buckets` usage cache,
`NodeMetrics` (sampling, not mirroring — Garage exposes only instantaneous values), `ClusterEvents`
(Garage keeps no history of itself), and `GarageClusterCache` (the only true mirror).
→ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#what-this-app-is)

## Workspace layout

Yarn v4 monorepo (`yarn@4.12.0`), three workspaces:

- `webapp/` (`@garage-ware/webapp`) — Next.js 16 + React 19 + Tailwind v4 + shadcn/ui. Mostly
  client-side; server code is confined to `webapp/src/app/next-api/*` and the `import 'server-only'`
  libraries it calls (`lib/garage/`, `lib/auth/server.ts`, most of `lib/storage/`).
- `shared/` (`@garage-ware/shared`) — ESM TS package: zod schemas, collection definitions, mutators,
  types. Subpath exports `./schema`, `./mutators`, `./mutator`, `./types`, `./enums`.
- `pocketbase/` (`@garage-ware/pb`) — binary, hooks ([main.pb.js](pocketbase/pb_hooks/main.pb.js)),
  migrations, seed-admin script. Production image keeps this at `/app/pb/`.

`shared/dist/` must exist for `webapp` to compile — run `yarn workspace @garage-ware/shared build`
after pulling or editing `shared/src/`.

## Common commands

```bash
yarn install && yarn setup      # initial setup (downloads PocketBase binary)
yarn dev                        # webapp + shared (watch) + pb
yarn workspace @garage-ware/webapp dev     # Next.js on :3000
yarn workspace @garage-ware/pb dev         # PocketBase on :8090
yarn workspace @garage-ware/shared dev     # tsup watch

yarn build | lint | lint:check | typecheck | format | format:check | test
yarn precommit                  # build:shared + lint + typecheck + format + test
yarn test                       # every test lives in webapp; shared's `test` is a stub

yarn workspace @garage-ware/webapp test src/lib/garage/garage-client.test.ts
yarn workspace @garage-ware/webapp test -t 'assertClaimDeltaAllowed'

yarn db:migrate | db:status     # generate migrations from shared/src/schema/
yarn workspace @garage-ware/pb admin <email> <password>   # create PB superuser
yarn workspace @garage-ware/pb seed-admin <user-email>    # promote existing user to app-admin
```

CI runs `install --immutable` → `build` → `format:check` → `lint:check` → `typecheck` → `test`.
Match that order locally before pushing.

## Repo and releases

Canonical remote **`github.com/make-ware/garage-ware`** (private). One build publishes identical
digests to **`dastron/garage-ware`** (Docker Hub, the public install path) and
**`ghcr.io/make-ware/garage-ware`**.

- **Conventional commits are load-bearing** — release-please derives version and changelog from them.
- Version lives in [package.json](package.json), [.release-please-manifest.json](.release-please-manifest.json)
  and the `v*` tag; release-please owns all three. **Never bump by hand.**
- One build, two registries — never two builds. Don't "simplify" the push-by-digest + `imagetools
  create` arrangement into a second matrix build.
- `DOCKERHUB_IMAGE` is the one hardcoded identifier and has to be; `secrets: inherit` on the
  release-please → docker-build call is required.
- → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#repo-location-and-release-pipeline)

## Required env vars

See [.env.example](.env.example) — [webapp/.env.example](webapp/.env.example) is a byte-identical
copy, so edit both or neither. Full rationale: → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#required-env-vars)

| Var | Scope | Notes |
|---|---|---|
| `NEXT_PUBLIC_POCKETBASE_URL` | browser | `/` in Docker (same-origin), `http://localhost:8090` in dev |
| `POCKETBASE_URL` / `_ADMIN_EMAIL` / `_ADMIN_PASSWORD` | server | migrations, seed-admin, `getPbAsSuperuser()` |
| `GARAGE_ADMIN_URL` / `GARAGE_ADMIN_TOKEN` | server | used by `lib/garage/` **and** the PB scrape cron (`$os.getenv`), so the PB process must see them. Token must never reach a `NEXT_PUBLIC_*` var |
| `GARAGE_S3_ENDPOINT` / `GARAGE_S3_REGION` | server, runtime | required (no default); served to the browser by `/next-api/config`. Deliberately not `NEXT_PUBLIC_` so one image can target any cluster. Buckets need CORS for the in-app browser |
| `GARAGE_PUBLIC_S3_ENDPOINT` | server, optional | endpoint *advertised* to users; falls back to `GARAGE_S3_ENDPOINT` |
| `GARAGE_AVG_OBJECT_SIZE_MB` | server, optional | derives a bucket's `maxObjects` from its byte quota; an `object_quota` override wins |
| `APP_PUBLIC_URL` | server | read by PB crons/hooks to build absolute email links |
| `GARAGE_COST_USD_PER_TB` / `GARAGE_HARDWARE_LIFESPAN_YEARS` | server, optional | defaults 22 / 5. The per-TB figure is **raw disk**; replication factor is applied in code from the live layout |
| `NODE_METRICS_RETENTION_DAYS` | server, optional | default 90, `0` keeps everything. Never prunes `ClusterEvents` |
| `SIGNUP_MODE` | server (PB) | `open` / `closed` / `invite`; **defaults to `closed`**, and an unrecognised value falls back to `closed`, never `open` |
| `SETUP_OWNER_EMAIL`, `SETUP_STATE_DIR` | server | unattended first-admin path; see [First run](docs/ARCHITECTURE.md#first-run-and-setup) |
| `FEATURE_NODE_CLAIMS` / `FEATURE_ASSET_CLAIMS` | Next.js only, default OFF | only `true`/`1` enables ([features.ts](webapp/src/lib/setup/features.ts), fails closed). `FEATURE_NODE_CLAIMS` gates **self-claim/self-release only** — admins assign owners and assigned owners still grant, flag or no flag. Routes enforce the flags regardless of UI |

## Architecture

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

Two back ends, two auth boundaries:

- **PocketBase** is reached directly from the browser via the JS SDK; all consumer files are
  `'use client'`; PB collection rules enforce per-user access. Rationale: [docs/PB_SSR.md](docs/PB_SSR.md).
- **Garage admin API** is server-side only, proxied through Route Handlers, which verify the PB
  token (`authRefresh`), authorize (Admins / `AccessKeys.user` / `Buckets.user`), then call Garage.

### Data model

| Collection | Role |
|---|---|
| `Users` (auth) | Identity + `notification_threshold_pct` (10–99, default 95). No storage field — claims are derived from the ledgers |
| `Admins` | `user` relation; membership grants the admin scope. Self-scoped listRule is what makes `isUserAdmin` work without a superuser |
| `AccessKeys` | `user`, `garage_key_id` (UNIQUE), `name`. Secret shown once, **never persisted or readable back**. All write rules `null`. No `expired` column — expiry is Garage state, joined at read time |
| `Buckets` | `user`, `garage_bucket_id` (UNIQUE), `name` (UNIQUE), `quota_gb`, `object_quota`, plus the usage cache (`bytes`, `objects`, `max_size`, `max_objects`, `usage_updated_at`). All write rules `null` |
| `StorageClaims` | Append-only ledger of per-node grants (`quota_gb` may be negative). All write rules `null`; `(user, node_id)` indexed but **not** unique |
| `StorageTransfers` | Append-only user→user handoffs, always positive, node-agnostic. No update path — a return is a delete |
| `StorageInvites` | A transfer whose recipient has no account. `to_email` is a lowercased `TextField`, not a relation. `status`: pending \| claimed \| failed |
| `NodeOwners` | Who may grant storage sourced from which node. `UNIQUE (node_id)` **is the concurrency control**. Stores the node *key*, never a full id |
| `StorageClaimAudit` | Immutable trail of every `StorageClaims` mutation, written by PB hooks. All references are `TextField`s so rows outlive what they describe |
| `StorageNodeBalances` / `StorageUserBalances` | Hook-maintained materialized roll-up of the ledgers. `claims_gb` is the **unfiltered** cross-node sum and is *not* the granted figure |
| `NodeMetrics` | Per-node time series, one row per node per 15-min scrape. Readable by any signed-in user; rows carry keys, so nothing to leak. Three separate "no reading" gates: `node_stats_ok`, `layout_ok`, `role_ok` |
| `GarageClusterCache` | Stale-while-revalidate cache of layout/status/health/replication factor. All five rules `null`, superuser-only |
| `ClusterEvents` | The cluster timeline. Three authors: `detector` (scrape cron), `manual` (admin), `action` (route handlers). All write rules `null`; sorted on `occurred_at`, never pruned. `ended_at` is the open/instant/resolved discriminator — there is no status column |

Full field lists and the reasoning for every `null` rule, `TextField`-not-relation and unique index:
→ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#data-model)

## Hard rules

**Storage accounting** → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#storage-accounting)
- `computeStorageSummary()` in [ledger-math.ts](webapp/src/lib/storage/ledger-math.ts) is the **only**
  implementation of the net-granted arithmetic. Anything that sums a ledger, values a node, or rolls
  entries up per node belongs there — not in a component. That file and `units.ts`, `object-cap.ts`,
  `node-label.ts` are deliberately **not** `server-only`.
- Guards read balances via `getUserPosition(pb, userId, layout?)` — both halves of the inequality
  from one read. List views use `getStorageSummariesForUsers` (2 queries regardless of user count).
  The per-row mutator aggregates (`sumByUser`, `sumAllocatedGb`, …) read one page and must not be
  used in a new guard.
- Editing an existing bucket's quota must go through `allocatedExcluding()`; omitting it refuses
  every increase on a user's largest bucket.
- **Four invariants:** per user `sum(bucket.quota_gb) ≤ netGranted`; per node
  `sum(claims) ≤ capacity / replicationFactor`; per user *and* node `sum(claims) ≥ 0`; a sender may
  only give away *unallocated* capacity, and a return needs the recipient to still cover their buckets.
- `assertClaimDeltaAllowed()` in [claim-ledger.ts](webapp/src/lib/storage/claim-ledger.ts) is the single
  guard for **every** claim mutation (POST `+amount`, DELETE `−amount`, PATCH `new − old`). The `pb`
  handed to it **must** be a superuser client, or it silently under-counts and waves through over-claims.
- Reverse a grant by appending a negative entry; DELETE exists only to fix mistyped rows.
- Claims on nodes absent from the layout are valued at 0 and can only be wound down.

**Cluster read cache** → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#cluster-read-cache)
- Display paths read [lib/garage/cached.ts](webapp/src/lib/garage/cached.ts) (`getCachedLayout` etc.,
  deliberately not exported from the `lib/garage` barrel).
- **Validators never read it** — claim mutations, transfer send/return, bucket quota validation,
  invite settlement, `/admin/status`, `/repairs/workers` and node claiming all fetch live. Check
  this first when adding a handler.
- The PB scrape cron cannot use it (Goja process, and a sample must record what it actually saw).

**Node identity** → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#node-identity)
- A node is identified by its **name** (a `name:`-prefixed layout tag) or its **node key** (first 16
  chars of the id, as `garage status` prints). Hostname is never an identifier. All of it lives in
  [node-label.ts](webapp/src/lib/node-label.ts); names resolve at display time, never denormalized.
- **The full 64-char node id never leaves the server** — PB stores keys everywhere, no route emits
  one, nothing renders one. [node-id-boundary.test.ts](webapp/src/app/next-api/garage/cluster/node-id-boundary.test.ts)
  enforces it. The one exception is *input*: the claim form on `/dashboard/nodes`.
- Key → id conversion is server-side only, via [node-resolve.ts](webapp/src/lib/garage/node-resolve.ts),
  against a **live** layout, 409 on ambiguity.

**Deletes, claims and ownership**
- **Buckets delete only when empty** (`describeBucketEmptiness()` fails closed); **keys are expired,
  never deleted**, and un-expiry is the safety property. A delete that 404s has succeeded. Ordering
  is Garage-first for deletes. → [#deleting-and-retiring](docs/ARCHITECTURE.md#deleting-and-retiring)
- Node ownership decides *who may append a row*, never *how much* — an owner's write runs through the
  same `assertClaimDeltaAllowed`. A non-admin claim needs a **full node id**; an admin assignment
  carries the key. `FEATURE_NODE_CLAIMS` gates only self-claiming; an owner's grant path never reads
  it. → [#node-ownership](docs/ARCHITECTURE.md#node-ownership)
- Asset claims prove ownership with the secret access key; bucket ownership is *derived* from
  Garage's `owner` permission. "No such key" and "wrong secret" are the same 403.
  → [#claiming-existing-keys-and-buckets](docs/ARCHITECTURE.md#claiming-existing-keys-and-buckets)
- UNIQUE indexes are the concurrency control — translate violations to 409 via `isUniqueViolation`;
  no pre-flight existence checks.

**PocketBase hooks** → [#claim-audit-trail](docs/ARCHITECTURE.md#claim-audit-trail), [#storage-balances](docs/ARCHITECTURE.md#storage-balances)
- Use `*Request` hooks (only they carry `e.auth`) and always wrap in `withRecordTx` — inside a request
  hook `e.app` is **not** transactional.
- `require` helpers *inside* each handler; Goja gives every callback a fresh executor.
- The actor arrives in `X-Claim-Actor-*` headers, honoured **only** under `e.hasSuperuserAuth()`.
- Pure hook libs (`signup-gate.js`, `cluster-events.js`, `claim-audit.js`'s `resolveActor`,
  `node-metrics.js`) are driven from vitest across the workspace boundary — keep them free of Goja
  globals, `require` and clocks.
- A non-zero drift from `storage-balance-rebuild` is **a bug, not maintenance**.

**Other subsystems** — one line each, details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md):
- [Storage invites](docs/ARCHITECTURE.md#storage-invites) — an invite promises, it does not reserve;
  settled oldest-first in sequence by `POST /next-api/garage/invites/claim`, not a signup hook.
- [Object quotas](docs/ARCHITECTURE.md#object-quotas) — `object_quota > 0` is an override, `0`/unset
  means derive; every `maxObjects` write goes through `effectiveMaxObjectsFor()`. Garage's `quotas`
  object replaces both axes, so an object-only edit must re-send `maxSize`.
- [Bucket quota drift](docs/ARCHITECTURE.md#bucket-quota-drift) — `syncQuotaToPb` refuses an increase
  the owner has no room for and returns a `QuotaSyncOutcome`. The OTP and name-challenge gates are
  React booleans, **not server-enforced**.
- [Storage cost card](docs/ARCHITECTURE.md#storage-cost-card) — lives in `lib/pricing/`; nothing under
  `lib/storage/` may import it. Bytes in, decimal TB for rates, replication factor is a term. Never
  invent a provider rate.
- [Node data coverage](docs/ARCHITECTURE.md#node-data-coverage) — `lib/metrics/`, display only, stays
  in bytes so it cannot typecheck into a ledger call site. Median not mean; fails loud.
- [Cluster events](docs/ARCHITECTURE.md#cluster-events) — detection folded into the scrape cron,
  read-before-write, `role_ok` is the upgrade guard, `diffObservations` and `reconcileOngoing` are pure
  and clockless, detection never fails the scrape. `/next-api/garage/cluster/events` projects
  field-by-field — never spread the record.
- [Ongoing conditions](docs/ARCHITECTURE.md#cluster-events) — `ended_at` carries three states in one
  column: `""` open, `= occurred_at` an instant, `> occurred_at` resolved. Only `ONGOING_KINDS`
  (`node_state`, `node_removed`) are ever left open; every other row is **born closed**. Conditions
  **open on an edge and close on state** — that asymmetry is load-bearing, and reversing it breaks the
  "first two scrapes produce an empty timeline" guarantee. A recurrence inside `FLAP_WINDOW_SEC`
  re-opens the same row and bumps `occurrence_count`; it never appends. Read `ended_at` through
  `eventStatus()`, never by hand, and never render a relative duration.
- [Repairs](docs/ARCHITECTURE.md#repairs) — every on-node call goes through
  [multi-node.ts](webapp/src/lib/garage/multi-node.ts); a node in neither map is `null` and means
  failure. `*` and `self` are refused. There is no last-scrub timestamp in the API, so
  [scrub-status.ts](webapp/src/lib/repair/scrub-status.ts) parses prose and `recognised: false` is its
  own UI state.
- [Cluster layout planner](docs/ARCHITECTURE.md#cluster-layout-planner) — `/admin/cluster/planner`
  simulates a layout **entirely client-side**; it adds no endpoint and stages nothing, because
  Garage only previews *staged* changes and `revert` bumps the layout version. `exact` (partition
  size, capacities) reproduces Garage; `estimated` (the per-node split) cannot and says so.
  `lib/cluster/layout-sim.ts` is bytes-only, display-only, and an import-boundary test keeps it out
  of the accounting path.
- [GarageHQ config generator](docs/ARCHITECTURE.md#garagehq-config-generator) — admin-only
  `/admin/setup/config-generator` turns a form into a `garage.toml`, **client-side only**, no
  endpoint and nothing persisted. It **never accepts or generates a secret**: `rpc_secret` and
  `admin_token` leave as `@PLACEHOLDER@` with the command that produces each beside them, and
  `garage-toml-secrets.test.ts` enforces that structurally. Emits Garage **v2** spelling
  (`replication_factor`, not `replication_mode`); zone and capacity are a comment block, because
  they are layout settings, not config keys.
- [Cluster layout staging](docs/ARCHITECTURE.md#cluster-layout-staging) —
  `/admin/cluster/staging` stages role changes through **`UpdateClusterLayout`
  and nothing else**; `Apply`/`Revert`/`SkipDeadNodes`/`Preview` are never
  wired, and `staging-boundary.test.ts` is structural. Garage has no CAS on that
  endpoint, so the version + `stagedFingerprint` check is ours — a mismatch is a
  409 and is **never retried**. An assign always sends zone, capacity *and*
  tags (the API blanks what you omit), so prefill is load-bearing. Reads are
  live, never `cached.ts`; an unparseable staged change renders as
  `unrecognised` rather than vanishing.
- [First run and setup](docs/ARCHITECTURE.md#first-run-and-setup) — the claim token bootstraps the
  first admin, guarded on **`Admins` being empty**, checked before the token. Two hooks refuse the
  removal of the last admin so that window never recurs.
- [Status and troubleshooting](docs/ARCHITECTURE.md#status-and-troubleshooting) — `/admin/status`
  never reads the cache, never renders a secret, and never takes the request host from `req.url`.
  The "No cluster yet?" card fires on `needsClusterSetup()` (`garage-admin-api === 'fail'` only) and
  is rendered by the call sites, not by `StatusChecks`. `/dashboard/cluster` gets its own redacted
  notice — root URL only, no env vars — keyed on HTTP 503/502, not on the error `code`. garage-ware
  links to GarageHQ's docs; it never installs a cluster or stores its secrets.

## Key invariants

- **Client-side PocketBase only.** No PB from a Server Component. Server-side PB exists only inside
  `/next-api/garage/*`, to verify the caller's token or act as a superuser. → [docs/PB_SSR.md](docs/PB_SSR.md)
- **Garage client is server-only.** Everything under `webapp/src/lib/garage/` starts with
  `import 'server-only'`; the bearer token must never reach the browser.
- **Mutators, not raw SDK** for PB reads — a `BaseMutator` subclass handles zod validation, expand,
  filters, error wrapping, realtime. Mutators live in `shared/`.
- **Every Garage response is parsed through a zod schema** in [schemas.ts](webapp/src/lib/garage/schemas.ts);
  errors map to the typed classes in [errors.ts](webapp/src/lib/garage/errors.ts).
- **`TypedPocketBase` is duplicated** — update [webapp/src/lib/types.ts](webapp/src/lib/types.ts)'s
  overload list too, not just shared's.
- **Schema → migration → restart.** Rebuild shared, `yarn db:migrate`, review the file, restart PB.
- **PB write rules are mostly not `null`** — where they aren't, the Route-Handler funnel is convention,
  not enforcement. Don't read a permissive rule as license to write from a component.

## Adding a collection

1. `shared/src/schema/<name>.ts` via `defineCollection()` + zod field helpers; export the collection,
   `Schema`, `InputSchema` and types. Patterns: `storage-claim.ts` (append-only ledger),
   `storage-claim-audit.ts` (hook-written, API-immutable), `cluster-event.ts` (human + hook writers).
2. Re-export from [shared/src/schema.ts](shared/src/schema.ts).
3. `shared/src/mutators/<name>.ts` extending `BaseMutator`; re-export from the mutators index.
4. Add a collection overload in [webapp/src/lib/types.ts](webapp/src/lib/types.ts).
5. `yarn workspace @garage-ware/shared build && yarn db:migrate`, review, restart PocketBase.

**Ordering caveat:** a rule referencing another collection needs that collection created first —
rename generated files so timestamps order dependencies.

**`yarn db:migrate` currently cannot generate at all** — the replay sandbox hits `require` in
[1786122444_created_StorageUserBalances.js](pocketbase/pb_migrations/1786122444_created_StorageUserBalances.js).
Hand-write migrations meanwhile: [1786200000_updated_Buckets.js](pocketbase/pb_migrations/1786200000_updated_Buckets.js)
for an additive field, [1786900000_created_ClusterEvents.js](pocketbase/pb_migrations/1786900000_created_ClusterEvents.js)
for a whole collection. Generated migrations are a starting point, not gospel — verify by restarting
PB and reading `/api/collections/<Name>`.

## Adding a /next-api/garage/* Route Handler

1. `webapp/src/app/next-api/garage/<...>/route.ts` exporting `GET`/`POST`/etc.
2. Start with `await getServerUser(req)` or `await requireAdmin(req)`; for ownership, load the row,
   compare `record.user !== user.id`, then fall back to `isUserAdmin(pb, user.id)`. All in
   [lib/auth/server.ts](webapp/src/lib/auth/server.ts).
3. `GarageClient.fromEnv()` + the relevant `lib/garage/` module. **Display-only handlers import
   `@/lib/garage/cached`; anything that validates stays live.**
4. Mutations: PB first, Garage second, roll back the PB row on failure (reverse for deletes). Wrap in
   `try/catch` with `errorResponse(err)`.
5. Writes to `AccessKeys`, `Buckets`, `StorageClaims`, `NodeOwners`, `ClusterEvents` or the balance
   collections need `getPbAsSuperuser()` (memoized). Reads stay on the caller's client so the
   self-or-admin listRules do the authorization.
6. From the client, call `api()` from [api-client.ts](webapp/src/lib/api-client.ts) — never a bare `fetch()`.

## Docker

[docker/Dockerfile](docker/Dockerfile) builds one container running PocketBase + Next.js + Nginx under
Supervisor, fronted by [docker/entrypoint.sh](docker/entrypoint.sh) (superuser upsert, `--automigrate`,
claim token). All state lives under `/data`. Nginx routes `/` → Next.js :3000, `/api/` and `/_/` →
PocketBase :8090, `/health` → PB probe. Build with `NEXT_PUBLIC_POCKETBASE_URL=/`.

**The builder stage mirrors the repo layout; only the runner renames `pocketbase/` → `pb/`** — a test
imports the hooks across the workspace boundary, so staging early breaks `next build`.

## Notes

- [docs/](docs/) is vendored upstream reference (PocketBase + Garage, incl. the full
  [OpenAPI spec](docs/GarageHQ_OPENAPI.json)). Check there before guessing at a PB rule or Garage
  endpoint. The two files about *this* app are [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
  [docs/PB_SSR.md](docs/PB_SSR.md).
- PocketBase JSVM typings only exist at `pocketbase/pb_data/types.d.ts`, written on first start.
  Hooks reach them through [pocketbase/jsconfig.json](pocketbase/jsconfig.json) — **never** re-add a
  `/// <reference path=... />` line; it fails `next build` on any checkout that has never run PB.
  `yarn check:refs` is the guard.
- ESLint ignores `pocketbase/**` and `scripts/**`. `react-hooks/set-state-in-effect` is strict —
  define an inner async function inside `useEffect` with a `cancelled` flag; canonical pattern in
  [dashboard/buckets/page.tsx](webapp/src/app/dashboard/buckets/page.tsx).
