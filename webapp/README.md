# garage-ware webapp

Next.js 16 + React 19 frontend for the Garage HQ S3 cluster management plane.

## Development

Run from the **monorepo root** — the webapp depends on `shared/dist/`:

```bash
yarn dev                                    # all workspaces (recommended)
yarn workspace @garage-ware/webapp dev      # webapp only (if shared & PB are already running)
```

App: [http://localhost:3000](http://localhost:3000)

## Project structure

```
webapp/src/
├── app/
│   ├── dashboard/          # User-facing pages (buckets, keys, usage)
│   ├── admin/              # Admin-only pages (cluster, nodes, claims)
│   └── next-api/garage/    # Server-side Route Handlers → Garage admin API
├── components/             # Feature components + shadcn/ui primitives
├── hooks/                  # Custom React hooks (use-auth, use-admin-status, …)
├── lib/
│   ├── garage/             # Garage admin API client (server-only)
│   ├── auth/               # Auth helpers (client + server)
│   ├── storage/            # Quota / claims helpers
│   ├── cluster/            # Cluster timeline + the layout planner's simulation
│   ├── api-client.ts       # Browser → /next-api fetch wrapper (attaches PB token)
│   ├── pocketbase.ts       # PocketBase singleton (client-side)
│   └── types.ts            # TypedPocketBase interface
└── test/                   # Vitest setup & stubs
```

## Architecture in brief

Two parallel back ends:

- **PocketBase** (`:8090`) — identity, mappings, quota claims. Reached directly from the browser via the JS SDK (`'use client'` only — no PB calls in Server Components).
- **Garage admin API** — cluster state, buckets, keys, usage. **Server-side only**, proxied through `/next-api/garage/*` Route Handlers. The Garage bearer token never reaches the browser.

```
Browser ──► PocketBase :8090          (auth, AccessKeys, Buckets, StorageClaims)
Browser ──► Next.js :3000
              └─► /next-api/garage/*  (verifies PB token, calls Garage admin API)
```

See [CLAUDE.md](../../CLAUDE.md) for the full architecture, data model, and invariants.

## Key rules

- **PocketBase is client-side only.** Use `'use client'` for any component that touches `pb`. Server-side PB instances exist only inside Route Handlers for auth verification.
- **Garage client is server-only.** Everything under `lib/garage/` is `import 'server-only'`.
- **Use mutators for PB reads.** Data access goes through `BaseMutator` subclasses from `@garage-ware/shared/mutators`, not raw `pb.collection(…)` calls.
- **Use `api()` for Route Handler calls.** `lib/api-client.ts` auto-attaches the PB bearer token.

## Scripts

```bash
yarn workspace @garage-ware/webapp dev        # dev server
yarn workspace @garage-ware/webapp build      # production build
yarn workspace @garage-ware/webapp typecheck  # tsc
yarn workspace @garage-ware/webapp lint       # eslint --fix
yarn workspace @garage-ware/webapp test       # vitest
```

## Adding shadcn/ui components

```bash
# from the webapp/ directory
npx shadcn@latest add <component>
```

## Environment variables

Copy [.env.example](.env.example) to `webapp/.env` — Next.js loads env from this
directory. It is a byte-identical copy of the [repo-root template](../.env.example).
Only `NEXT_PUBLIC_POCKETBASE_URL` is client-visible. All Garage and server-side PB credentials must **not** use the `NEXT_PUBLIC_` prefix.
