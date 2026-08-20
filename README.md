# garage-ware

Self-hosted management console for a [Garage HQ](https://garagehq.deuxfleurs.fr/) S3-compatible storage cluster. Single Docker image, single `/data` volume to back up.

- **Web**: Next.js 16 + React 19 + Tailwind v4 + shadcn/ui (App Router, client-side PocketBase)
- **Backend**: PocketBase (identity, access-key/bucket mappings, storage claims) + Garage admin API (proxied server-side)
- **Shared**: Zod schemas + typed mutators in a workspace package
- **Monorepo**: Yarn v4 workspaces (`webapp`, `shared`, `pocketbase`)

Repo: [make-ware/garage-ware](https://github.com/make-ware/garage-ware) · Images: `dastron/garage-ware` (Docker Hub) and `ghcr.io/make-ware/garage-ware` (GHCR)

## Self-host with Docker

You need a [running Garage cluster](https://garagehq.deuxfleurs.fr/documentation/quick-start/)
with a layout applied, and an admin token for it
(`garage admin-token create --name garage-ware`). garage-ware manages a cluster;
it does not install one.

Every release publishes a multi-arch (`linux/amd64` + `linux/arm64`) image to Docker Hub as [`dastron/garage-ware`](https://hub.docker.com/r/dastron/garage-ware). It is public, so no registry login is needed:

```bash
git clone https://github.com/make-ware/garage-ware.git
cd garage-ware

cp .env.docker.example .env.docker   # set GARAGE_ADMIN_URL, GARAGE_ADMIN_TOKEN, GARAGE_S3_ENDPOINT
docker compose up -d
```

Then read the setup banner and follow it:

```bash
docker compose logs garage-ware | grep '\[setup\]'
```

It prints a URL and a one-time claim token. Open the URL, create your account,
paste the token — you are now the administrator. `/admin/status` then reports
anything still misconfigured, with the fix for each — and, when it cannot reach
a cluster at all, links to Garage's own installation docs.

Pin a release instead of tracking `latest` by setting the image tag to
`dastron/garage-ware:v1.8.3`. To build from your checkout instead of
pulling, uncomment the `build:` block in [docker-compose.yml](docker-compose.yml).

The identical image is also published to `ghcr.io/make-ware/garage-ware`, which
is where development work pulls from. Both registries are public and serve the
same digests, so either tag works — Docker Hub is simply the one this README
points at.

Three things worth knowing before you invite anyone:

- **Sign-up is closed by default** (`SIGNUP_MODE=closed`; set `invite` or
  `open` to loosen it). While no administrator exists it stays open so you can
  create the account you will claim with, which is why claiming promptly
  matters. Self-service claiming is likewise off until you set
  `FEATURE_NODE_CLAIMS=true` / `FEATURE_ASSET_CLAIMS=true`. Until then an
  administrator assigns node owners on **Admin → Nodes** (an assigned owner can
  still grant storage from their node) and imports existing keys and buckets.
- **Email needs configuring** at `/_/#/settings/mail`, or invites and password
  resets silently never arrive.
- **A new user has no storage** until you grant them a claim from
  **Admin → Claims**.

**Everything that needs to persist lives under `/data`.** PocketBase database, uploaded files, the generated superuser password, first-run state. To back up, snapshot the directory:

```bash
tar czf backup.tgz -C $PWD data
```

To restore on a new host: copy the tarball, extract, bring the container up against the same path.

See [docker/README.md](docker/README.md) for the full environment reference, SMTP and bucket-CORS setup, and a troubleshooting table.

## Develop locally

```bash
git clone https://github.com/make-ware/garage-ware.git
cd garage-ware

yarn install        # node 20+, yarn 4 via corepack
yarn setup          # downloads the PocketBase binary for your OS
yarn dev            # webapp on :3000, PocketBase on :8090, shared in watch mode
```

Create a PocketBase admin account: `yarn workspace @garage-ware/pb admin <email> <password>`.

## Adding a collection

Schemas are the source of truth. Migrations are generated from them.

1. Create `shared/src/schema/<Name>.ts` using `defineCollection()` plus zod field helpers from `pocketbase-zod-schema` (`TextField`, `RelationField`, `BoolField`, etc.). Export the collection, schema, input schema, and inferred types.
2. Re-export from [shared/src/schema.ts](shared/src/schema.ts).
3. Create `shared/src/mutators/<Name>.ts` extending `BaseMutator` (see [shared/src/mutators/base.ts](shared/src/mutators/base.ts)). Re-export from [shared/src/mutators/index.ts](shared/src/mutators/index.ts).
4. Add a collection overload in [webapp/src/lib/types.ts](webapp/src/lib/types.ts).
5. Generate the migration:
   ```bash
   yarn workspace @garage-ware/shared build
   yarn db:migrate
   ```
   Review the file in [pocketbase/pb_migrations/](pocketbase/pb_migrations/), then restart PocketBase — it auto-applies on startup.

## Architecture invariants

- **Client-side PocketBase only.** Don't call PocketBase from a Server Component or Route Handler. See [docs/PB_SSR.md](docs/PB_SSR.md).
- **Mutators, not raw SDK.** Data access goes through a `BaseMutator` subclass. Direct `pb.collection(...).create(...)` is a smell — mutators handle zod validation, default expand/filter/sort, error wrapping, realtime subscriptions.
- **Schema → migration → restart.** After editing `shared/src/schema/`, rebuild shared, run `yarn db:migrate`, restart PocketBase.

## Common scripts

```bash
yarn build         # all workspaces
yarn test          # shared + webapp
yarn lint          # autofix
yarn typecheck
yarn db:migrate    # generate migrations from schema changes
yarn db:status     # check migration sync state
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `install --immutable` → `build` → `format:check` → `lint:check` → `typecheck` → `test`.

## Releases

Conventional commits on `main` drive [release-please](.github/workflows/release-please.yml), which maintains a release PR bumping [package.json](package.json), [.release-please-manifest.json](.release-please-manifest.json), and [CHANGELOG.md](CHANGELOG.md). Merging it tags `vX.Y.Z`, cuts a GitHub release, and calls [docker-build.yml](.github/workflows/docker-build.yml) to publish `ghcr.io/make-ware/garage-ware:vX.Y.Z` and `:latest`.

Both workflows are repo-location agnostic — the image name comes from `${{ github.repository }}` and auth from the built-in `GITHUB_TOKEN`, so nothing needs editing if the repo moves again. To publish outside a release, push a `v*.*.*` tag or run **Docker Build and Publish** from the Actions tab.

### Two registries, one build

Every release publishes to both:

| Registry | Image | For |
|---|---|---|
| Docker Hub | `dastron/garage-ware` | the public install path |
| GHCR | `ghcr.io/make-ware/garage-ware` | development |

Both are public, so neither needs a login to pull. Docker Hub needs two repository secrets to *push* — `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (an access token with Read & Write), under *Settings → Secrets and variables → Actions*. GHCR uses the built-in `GITHUB_TOKEN`.

Each per-arch image is pushed **by digest to both registries in the same build**, then one manifest list per registry is assembled from those digests — so the two serve byte-identical images with identical digests, not two independent builds. Tags match on both sides (`vX.Y.Z` and `latest`).

Unlike the GHCR name, the Docker Hub repo is hardcoded in [docker-build.yml](.github/workflows/docker-build.yml): a Docker Hub namespace is its own account and does not follow the git repo if it moves. A fork needs to edit that one `DOCKERHUB_IMAGE` line, or the Docker Hub push will fail on credentials it does not have.

## License

MIT — see [LICENSE](LICENSE).
