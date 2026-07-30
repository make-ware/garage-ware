# Docker Image

Single-container deployment of the Next.js webapp + PocketBase + Nginx, supervised by `supervisord`. All runtime state lives under `/data` — bind-mount that one path and you're done.

## Architecture

- **Nginx** (port 80) — reverse proxy, public entry point
- **Next.js** (internal :3000) — frontend
- **PocketBase** (internal :8090) — API, admin UI, SQLite, file storage
- **Supervisor** — process manager

Hooks ([pocketbase/pb_hooks/](../pocketbase/pb_hooks/)) and migrations ([pocketbase/pb_migrations/](../pocketbase/pb_migrations/)) are baked into the image — they're code, not data. Source-tree path is `pocketbase/`; in the running container they live under `/app/pb/`.

## Pull the published image

[.github/workflows/docker-build.yml](../.github/workflows/docker-build.yml) publishes a multi-arch manifest (`linux/amd64` + `linux/arm64`) to `ghcr.io/make-ware/garage-ware` on every release, tagged `vX.Y.Z` and `latest`. The image name is derived from `${{ github.repository }}`, so it tracks the repo's location automatically.

The repo is private, so the package inherits that — `docker login ghcr.io` with a PAT holding `read:packages` before pulling:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
docker pull ghcr.io/make-ware/garage-ware:latest
```

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
  --build-arg POCKETBASE_VERSION=0.35.1 \
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

## Run

```bash
docker run -d --name garage-ware \
  -p 80:80 \
  -v $PWD/data:/data \
  garage-ware
```

Routes:

- `/` → Next.js
- `/api/` → PocketBase API
- `/_/` → PocketBase admin UI
- `/health` → PocketBase health probe

First boot: visit `/_/` to create the PocketBase admin account.

## The `/data` contract

Everything the running container persists writes to `/data`:

- `/data/pb_data/` — PocketBase SQLite (`data.db`, `auxiliary.db`) and file uploads (`storage/`)

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
  -e NODE_ENV=production \
  garage-ware
```

`GARAGE_S3_ENDPOINT` / `GARAGE_S3_REGION` are the public S3 gateway URL + region
the in-app file browser and bucket "connect" page point at. They are served to
the browser at runtime via `/next-api/config`, so changing them is a pod env
edit + restart — no image rebuild. `GARAGE_S3_ENDPOINT` is **required** and has
no default; `GARAGE_S3_REGION` defaults to `us-east-1`.

`GARAGE_AVG_OBJECT_SIZE_MB` is optional. When set (average object size in MB), the bucket route handlers derive each bucket's `maxObjects` quota from its byte quota (`floor(quota_bytes / (value × 1MB))`). Leave unset to apply no object-count cap. Add it as another `-e GARAGE_AVG_OBJECT_SIZE_MB=…` flag if you want the cap.

`APP_PUBLIC_URL` is read by the PocketBase daily `bucket-usage-alerts` cron to build absolute CTA links in alert emails. If unset, the cron skips sending and logs a warning.

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
- [start.sh](start.sh) — entrypoint that execs supervisord
