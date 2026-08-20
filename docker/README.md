# Docker Image

Single-container deployment of the Next.js webapp + PocketBase + Nginx, supervised by `supervisord`. All runtime state lives under `/data` — bind-mount that one path and you're done.

## Architecture

- **Nginx** (port 80) — reverse proxy, public entry point
- **Next.js** (internal :3000) — frontend
- **PocketBase** (internal :8090) — API, admin UI, SQLite, file storage
- **Supervisor** — process manager

Hooks ([pocketbase/pb_hooks/](../pocketbase/pb_hooks/)) and migrations ([pocketbase/pb_migrations/](../pocketbase/pb_migrations/)) are baked into the image — they're code, not data. Source-tree path is `pocketbase/`; in the running container they live under `/app/pb/`.

## Pull the published image

[.github/workflows/docker-build.yml](../.github/workflows/docker-build.yml) publishes a multi-arch manifest (`linux/amd64` + `linux/arm64`) on every release, tagged `vX.Y.Z` and `latest`, to **two registries**:

| Registry | Image | For |
|---|---|---|
| Docker Hub | `dastron/garage-ware` | the public install path |
| GHCR | `ghcr.io/make-ware/garage-ware` | development |

Both are public, so pulling needs no login:

```bash
docker pull dastron/garage-ware:latest
# or, the same digests:
docker pull ghcr.io/make-ware/garage-ware:latest
```

It is one build, not two: each per-arch image is pushed **by digest to both registries at once**, and one manifest list per registry is assembled from the same digests — so the two registries serve byte-identical images. The GHCR name is derived from `${{ github.repository }}` and tracks the repo's location automatically; the Docker Hub name is hardcoded, since a Docker Hub namespace is its own account and does not follow the git repo. Pushing to Docker Hub uses the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repository secrets; GHCR uses the built-in `GITHUB_TOKEN`.

Published images carry `org.opencontainers.image.source` (on both the per-arch images and the merged manifest), which is what links the GHCR package back to this repo — that link is what lets the package inherit the repo's access list instead of needing its own.

The published image is built with `NEXT_PUBLIC_POCKETBASE_URL=/` (the SDK appends `/api/...` itself, which nginx proxies to PocketBase). If you need a different value, build locally — `NEXT_PUBLIC_*` is baked in at build time (see below).

## Build

From the repo root:

```bash
docker build -f docker/Dockerfile -t garage-ware .
```

Pin a specific PocketBase release at build time:

```bash
docker build -f docker/Dockerfile \
  --build-arg POCKETBASE_VERSION=0.39.10 \
  --build-arg POCKETBASE_ARCH=amd64 \
  -t garage-ware .
```

### `NEXT_PUBLIC_*` are build-time, not runtime

Next.js inlines every `NEXT_PUBLIC_*` variable into the client JS bundle when
`next build` runs. Setting them on the running container (`docker run -e …` or
a k8s pod `env:`) has **no effect** — the bundle already contains the value
baked in at build time. To change one you must rebuild with a `--build-arg`:

```bash
docker build -f docker/Dockerfile \
  --build-arg NEXT_PUBLIC_POCKETBASE_URL=/api \
  -t garage-ware .
```

Default if omitted: `NEXT_PUBLIC_POCKETBASE_URL=/`.

The S3 gateway endpoint/region are deliberately **not** `NEXT_PUBLIC_*` — they
are runtime env (`GARAGE_S3_ENDPOINT` / `GARAGE_S3_REGION`), served to the
browser by the `/next-api/config` route. Set them per deployment with plain
runtime env (see below); no rebuild needed.

## First run

The quickest path is Compose, from a checkout:

```bash
cp .env.docker.example .env.docker   # fill in GARAGE_ADMIN_URL / TOKEN / S3 endpoint
docker compose up -d
docker compose logs garage-ware | grep '\[setup\]'
```

That last command prints the setup banner:

```
[setup] PocketBase superuser ready: admin@garage-ware.local
[setup]   password generated — read it from /data/pb_superuser.env (mode 0600)
[setup] ---------------------------------------------------------------
[setup] This instance has no administrator yet. Claim it:
[setup]
[setup]   1. Open  http://localhost:8080/setup
[setup]   2. Create your account
[setup]   3. Paste this claim token:
[setup]
[setup]      9DzA4sgMptRkfiKVBF9PQGPUCg4357Xf
[setup]
[setup]   (also stored at /data/setup/claim-token)
[setup]
[setup] PocketBase admin UI: http://localhost:8080/_/  (user admin@garage-ware.local)
[setup]
[setup] Configuration check:
[setup]   ! GARAGE_ADMIN_URL is not set — cluster status, buckets, keys and metrics will not work
[setup] ---------------------------------------------------------------
```

Follow it: open `/setup`, create your account, paste the token. You are now the
administrator, and `/admin/status` tells you what is still misconfigured.

Without Compose the same flow works with plain `docker run` — see
[Environment variables](#environment-variables) for the flags.

### Why a claim token

The app-level `Admins` collection gates its own creation (`@collection.Admins.user
?= @request.auth.id`), so the first administrator cannot be made through the API.
The container mints a token on first boot and prints it; being able to read this
container's logs or its `/data` volume is the proof of ownership.

The token is **only ever accepted while no administrator exists**. That, rather
than the token's secrecy, is the guard — once the instance is claimed, a leaked
token is inert and a second claim attempt gets a 409.

Two alternatives, both optional:

- `SETUP_OWNER_EMAIL=you@example.com` — whoever signs up with that exact address
  is promoted automatically, and only while no administrator exists.

  **This is weaker than the token, and the difference matters.** The token is a
  secret; an email address usually is not. Between the container starting and
  you claiming it, sign-up is open and email verification is not required — so
  anyone who can reach the app and guesses the address takes the administrator
  seat. Use it for unattended installs on a network the public cannot reach, or
  claim immediately after starting. The token has no such window: reading it
  requires access to the logs or the volume.
- `SETUP_CLAIM_TOKEN=…` — supply the token yourself from a secret manager. When
  set, nothing is written to disk.

If you lose the token before claiming, restart the container: it reuses the
stored one, or mints a fresh one if `/data/setup/claim-token` is gone. As a last
resort the image ships the manual path:

```bash
docker compose exec garage-ware node /app/pb/scripts/seed-admin.mjs you@example.com
```

### Who can sign up

`SIGNUP_MODE` controls it, and defaults to **`closed`**:

| Value | Who may create an account |
|---|---|
| `closed` (default) | Nobody — administrators create every account |
| `invite` | Addresses holding a pending storage invite, plus accounts an admin creates from `/admin/users` |
| `open` | Anyone who can reach the sign-up page |

An unset or unrecognised value falls back to `closed`, never `open`, so a typo
cannot throw the doors open.

**While no administrator exists, sign-up stays open regardless of this setting** —
otherwise a fresh install would lock out its own owner before they could claim
it. Signing up in that window grants nothing on its own; becoming an
administrator still needs the claim token. Claim promptly.

## Routes

- `/` → Next.js
- `/api/` → PocketBase API
- `/_/` → PocketBase admin UI
- `/health` → PocketBase health probe
- `/next-api/health` → app health probe (what the image's `HEALTHCHECK` uses —
  reaching it proves Next.js is up, and its body proves Next.js can reach
  PocketBase)

## The `/data` contract

Everything the running container persists writes to `/data`:

- `/data/pb_data/` — PocketBase SQLite (`data.db`, `auxiliary.db`) and file uploads (`storage/`)
- `/data/pb_superuser.env` — generated PocketBase superuser credentials, mode 0600. Only written when you did not supply `POCKETBASE_ADMIN_EMAIL`/`POCKETBASE_ADMIN_PASSWORD` yourself. **Back this up or record the password** — losing it means resetting the superuser by hand.
- `/data/setup/` — first-run state: `claim-token` until the instance is claimed, then a `claimed` marker.

Reserve the rest of `/data` for any future app-level dynamic state (cache, generated files). Mount one host directory to that path and your container is stateful; nothing else needs to be persisted.

The Dockerfile declares `VOLUME ["/data"]`, so an unconfigured `docker run` still gets a Docker-managed volume — you won't lose data by forgetting `-v`. Bind-mount in production for predictable backups.

### Backup and restore

```bash
# Back up
tar czf backup-$(date +%F).tgz -C $PWD data

# Restore on a fresh host
tar xzf backup-2026-05-05.tgz
docker run -d --name garage-ware -p 80:80 -v $PWD/data:/data garage-ware
```

Stop the container before backing up if you need a strictly consistent SQLite snapshot. PocketBase also exposes backup tooling at `/_/#/settings/backups` if you prefer in-app snapshots.

## Environment variables

Server-side vars are passed at `docker run` time. Note `NEXT_PUBLIC_*` vars are
**not** in this list — those are build-time only (see [Build](#nextpublic_-are-build-time-not-runtime) above).

```bash
docker run -d --name garage-ware \
  -p 80:80 \
  -v $PWD/data:/data \
  -e APP_PUBLIC_URL=https://your-domain \
  -e GARAGE_ADMIN_URL=https://garage-admin.your-domain \
  -e GARAGE_ADMIN_TOKEN=… \
  -e GARAGE_S3_ENDPOINT=https://s3.your-domain \
  -e GARAGE_S3_REGION=us-east-1 \
  -e SIGNUP_MODE=closed \
  -e NODE_ENV=production \
  garage-ware
```

| Variable | Required | Effect if unset |
|---|---|---|
| `GARAGE_ADMIN_URL` | yes | No cluster status, buckets, keys or metrics. This is the **admin** port (3903 by default), not the S3 port (3900). |
| `GARAGE_ADMIN_TOKEN` | yes | Same. Mint one on a cluster node: `garage admin-token create --name garage-ware` |
| `GARAGE_S3_ENDPOINT` | yes | The in-app file browser and bucket "connect" page return an error. No default, on purpose — a fallback would silently point every deployment at someone else's cluster. |
| `GARAGE_S3_REGION` | no | Defaults to `us-east-1`. |
| `GARAGE_PUBLIC_S3_ENDPOINT` | no | Falls back to `GARAGE_S3_ENDPOINT`. Set it when the URL you advertise to users differs from the CORS-enabled gateway the in-app browser must talk to. |
| `APP_PUBLIC_URL` | recommended | Storage-invite emails and daily usage alerts are **skipped entirely** — the invite row is still written, but nobody is told. |
| `SIGNUP_MODE` | no | Defaults to `closed`. See [Who can sign up](#who-can-sign-up). |
| `FEATURE_NODE_CLAIMS` | no | Defaults to off — users cannot claim a node for themselves or release one; admins assign owners on `/admin/nodes`, and an assigned owner can still grant storage from their node. Set `true` to enable self-claiming. |
| `FEATURE_ASSET_CLAIMS` | no | Defaults to off — users cannot self-claim pre-existing Garage keys/buckets; admins import them instead. Set `true` to enable. |
| `SETUP_OWNER_EMAIL` | no | Use the printed claim token instead. |
| `SETUP_CLAIM_TOKEN` | no | The container mints one and stores it under `/data/setup/`. |
| `POCKETBASE_ADMIN_EMAIL` / `POCKETBASE_ADMIN_PASSWORD` | no | The container generates them on first boot and stores them at `/data/pb_superuser.env`. **Set both or neither** — setting one is a hard error. |
| `GARAGE_AVG_OBJECT_SIZE_MB` | no | No object-count cap is derived for buckets. |
| `NODE_METRICS_RETENTION_DAYS` | no | Defaults to 90. `0` keeps everything. |

> `POCKETBASE_ADMIN_EMAIL` / `POCKETBASE_ADMIN_PASSWORD` are needed **at runtime**,
> not just by tooling: the webapp authenticates with them for every privileged
> operation. Earlier versions of this document omitted them from the run example,
> which left the cluster read cache, storage invites, user-to-user transfers,
> cluster events and the admin invite flow returning 500 on an otherwise
> correct-looking deployment. The container now handles them for you.

### Email (SMTP)

**Nothing works by default.** PocketBase falls back to a local `sendmail` binary
that this image does not contain, so every send fails. That costs you:

- inviting a user from `/admin/users` fails with a 502 (the account is rolled back),
- storage-invite emails are dropped silently — the invite still exists, the
  recipient is simply never told,
- password resets never arrive,
- the daily bucket usage alerts never send.

Configure it once at `/_/#/settings/mail` in the PocketBase admin UI: SMTP host,
port, credentials, and a sender address. `/admin/status` reports whether it is
enabled.

### Bucket CORS

The in-app file browser signs S3 requests **in the browser** with the user's own
credentials and talks to `GARAGE_S3_ENDPOINT` directly — so each bucket must
allow CORS from this app's origin, or the browser blocks the request before it
leaves. Nothing server-side can detect or fix this for you.

Apply per bucket, replacing the origin with your own:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://your-domain"],
      "AllowedMethods": ["GET", "PUT", "HEAD"],
      "AllowedHeaders": ["authorization", "x-amz-*", "content-type"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

```bash
aws s3api put-bucket-cors --bucket <name> --cors-configuration file://cors.json \
  --endpoint-url https://s3.your-domain
```

### Prerequisites on the cluster side

Two things this app cannot do for you, and which make it look broken:

1. **A layout must be applied** (`garage layout assign` / `garage layout apply`).
   Without one every node values at zero capacity, so no storage can be claimed
   and no bucket created.
2. **Users need a storage claim.** A new account has none, so its dashboard shows
   zero capacity and bucket creation is refused. Grant capacity from
   **Admin → Claims**.

## Troubleshooting

`/admin/status` runs these checks live and tells you which is failing. The `id`
column matches what the page reports.

When `garage-admin-api` fails outright — the vars are unset, or nothing answered
— the page adds a "No cluster yet?" card below the checks, linking to Garage's
own quickstart, configuration reference and production cookbook. garage-ware
manages a cluster; it never installs one or stores its credentials.

| Check | Symptom | Fix |
|---|---|---|
| `pocketbase-superuser` | Invites, transfers, cluster events and the cluster cache 500 | Set both `POCKETBASE_ADMIN_EMAIL`/`PASSWORD`, or let the container generate them and don't override just one |
| `garage-admin-api` — "Connection refused" | Nothing is listening | Cluster down, or the URL points at a port nothing serves |
| `garage-admin-api` — "not as the Garage v2 admin API" | Something answered with an unexpected status | `GARAGE_ADMIN_URL` is aimed at the S3 port (3900) rather than the admin port (3903) |
| `garage-admin-api` — "could not resolve" | DNS failure | The hostname is not resolvable *from inside the container* — check your Docker network |
| `garage-admin-api` — "rejected admin token" | 401/403 | Mint a fresh token: `garage admin-token create --name garage-ware` |
| `garage-admin-api` — "lost quorum" | Cluster reachable, too few nodes up | Fix node health first; nothing else here will be meaningful |
| `garage-layout` — "No layout has been applied" | Zero capacity everywhere | `garage layout assign` then `garage layout apply` |
| `s3-gateway` | File browser errors | Set `GARAGE_S3_ENDPOINT`; check per-bucket CORS |
| `app-public-url` | Emails contain broken links, or none arrive | Set `APP_PUBLIC_URL` to the URL users actually use |
| `smtp` | Invites 502, resets never arrive | Configure mail at `/_/#/settings/mail` |
| `metrics-scrape` | Metrics charts empty | Needs `GARAGE_ADMIN_URL`/`TOKEN`; the cron runs every 15 min |
| `balance-drift` | Non-zero drift | A bug, not routine maintenance — worth reporting |
| `access` | Unexpected sign-ups, or none possible | Check `SIGNUP_MODE` (and the `FEATURE_*` flags it reports) |

`GARAGE_S3_ENDPOINT` / `GARAGE_S3_REGION` are the public S3 gateway URL + region
the in-app file browser and bucket "connect" page point at. They are served to
the browser at runtime via `/next-api/config`, so changing them is a pod env
edit + restart — no image rebuild. `GARAGE_S3_ENDPOINT` is **required** and has
no default; `GARAGE_S3_REGION` defaults to `us-east-1`.

`GARAGE_AVG_OBJECT_SIZE_MB` is optional. When set (average object size in MB), the bucket route handlers derive each bucket's `maxObjects` quota from its byte quota (`floor(quota_bytes / (value × 1MB))`). Leave unset to apply no object-count cap. Add it as another `-e GARAGE_AVG_OBJECT_SIZE_MB=…` flag if you want the cap.

`APP_PUBLIC_URL` is read by the PocketBase daily `bucket-usage-alerts` cron to build absolute CTA links in alert emails. If unset, the cron skips sending and logs a warning.

`GARAGE_ADMIN_URL` / `GARAGE_ADMIN_TOKEN` are also read by the PocketBase `node-metrics-scrape` cron (every 15 minutes, feeds the `/dashboard/metrics` charts) — supervisord children inherit the container env, so the `-e` flags above cover it. If unset, that cron skips and logs a warning. `NODE_METRICS_RETENTION_DAYS` (optional, default 90, `0` = keep forever) bounds how much metrics history the cron keeps; add it as another `-e` flag to change it.

See [.env.example](../.env.example) for the full list.

## Logs

All process output (supervisord lifecycle events, PocketBase, Next.js, nginx access + error) is forwarded to the container's stdout/stderr, so the standard Docker tooling works:

```bash
docker logs garage-ware            # full output
docker logs -f garage-ware         # follow
docker logs --tail 200 garage-ware # last 200 lines
```

If you ship logs to an aggregator, configure Docker's log driver (`--log-driver`) — no per-process file paths to wire up.

## Files in this directory

- [Dockerfile](Dockerfile) — multi-stage build
- [supervisord.conf](supervisord.conf) — process definitions; PocketBase invocation pins `--dir=/data/pb_data` plus `--hooksDir` / `--migrationsDir` against the in-image paths
- [nginx.conf](nginx.conf) — reverse-proxy routing, websocket support for PocketBase realtime
- [entrypoint.sh](entrypoint.sh) — bootstraps the PocketBase superuser and the admin claim token, prints the setup banner, then execs supervisord
