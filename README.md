# garage-ware

Self-hosted management console for a [Garage HQ](https://garagehq.deuxfleurs.fr/) S3-compatible storage cluster. Single Docker image, single `/data` volume to back up.

- **Web**: Next.js 16 + React 19 + Tailwind v4 + shadcn/ui (App Router, client-side PocketBase)
- **Backend**: PocketBase (identity, access-key/bucket mappings, storage claims) + Garage admin API (proxied server-side)
- **Shared**: Zod schemas + typed mutators in a workspace package
- **Monorepo**: Yarn v4 workspaces (`webapp`, `shared`, `pocketbase`)

Repo: [make-ware/garage-ware](https://github.com/make-ware/garage-ware) · Images: `ghcr.io/make-ware/garage-ware`

## Self-host with Docker

Every release publishes a multi-arch (`linux/amd64` + `linux/arm64`) image to GHCR. The repo is private, so the package is too — authenticate to `ghcr.io` first with a personal access token that has `read:packages`:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

docker run -d --name garage-ware \
  -p 80:80 \
  -v $PWD/data:/data \
  ghcr.io/make-ware/garage-ware:latest
```

Pin a release instead of tracking `latest` with `ghcr.io/make-ware/garage-ware:v1.4.13`.

Or build from a checkout:

```bash
git clone https://github.com/make-ware/garage-ware.git
cd garage-ware

docker build -f docker/Dockerfile -t garage-ware .

docker run -d --name garage-ware \
  -p 80:80 \
  -v $PWD/data:/data \
  garage-ware
```

Open http://localhost — Next.js on `/`, PocketBase API on `/api/`, admin on `/_/`.

**Everything that needs to persist lives under `/data`.** PocketBase database, uploaded files, anything else the app writes at runtime. To back up, snapshot the directory:

```bash
tar czf backup.tgz -C $PWD data
```

To restore on a new host: copy the tarball, extract, run the same `docker run` against the same path.

First-time setup: visit `http://localhost/_/` to create your PocketBase admin account. See [docker/README.md](docker/README.md) for routing details, env vars, and logs.

## Develop locally

```bash
git clone https://github.com/make-ware/garage-ware.git
cd garage-ware

yarn install        # node 20+, yarn 4 via corepack
yarn setup          # downloads the PocketBase binary for your OS
yarn dev            # webapp on :3000, PocketBase on :8090, shared in watch mode
```

Create a PocketBase admin account: `yarn workspace @garage-ware/pb admin`.

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

## License

MIT — see [LICENSE](LICENSE).
