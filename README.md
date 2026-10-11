# Design editor

Design editor is an Electron desktop editor that connects a real React repository to a React and DOM design canvas. The first vertical slice discovers design-system atoms, composes a login screen, prepares scoped minimal source patches, detects external changes, and promotes the composition into a real TSX component.

Read `START-HERE.md`, `AGENTS.md`, and `PRODUCT-SPEC.md` before contributing. For UI work, read `GUI.md` and use the installed Graphical skills.

Current implementation priorities are tracked in `TODO.md`.

## Development

Prerequisites:

- Node.js 24
- pnpm 10.6.2

Install and verify:

```sh
pnpm install
pnpm verify
```

Run Docker Postgres, migrations, the local API, login app, sync service, asset Worker, web app, isolated preview, and Electron host:

```sh
pnpm dev
```

Run the same cloud-shaped local stack without Electron:

```sh
pnpm dev:cloud
```

Both commands build the scanner and preview runtime, scan `fixtures/component-repo`, and write a fresh integrity-bound component registry to `.design-editor/runtime/verified-component-registry.json`. The preview on port 4318 and thumbnail renderer on port 4323 receive the same absolute manifest path. They fail startup if the manifest is absent, malformed, or stale. Use `pnpm dev:preview` for the same preparation path when running only the preview, or `pnpm registry:prepare` to inspect the generated evidence without starting a service.

Build an unsigned Windows installer against the local services:

```sh
pnpm build:package:local
```

Build the production installer after copying `.env.production.example` to `.env.production` and replacing its public origins:

```sh
pnpm build:package:prod
```

Local and production artifacts are written to `apps/desktop/release/local` and `apps/desktop/release/production`. Packaging builds its child-process environment from a fixed Windows OS and toolchain allowlist, then adds only the public desktop and `VITE_` origins from the selected environment file. Ambient credentials and unrelated shell variables are not inherited.

Local origins mirror the hosted service boundaries:

- editor: `http://127.0.0.1:4317`
- preview: `http://127.0.0.1:4318`
- login: `http://127.0.0.1:4319`
- API: `http://127.0.0.1:4320`
- sync: `ws://127.0.0.1:4321`
- file assets: `http://127.0.0.1:4322`
- thumbnail renderer: `http://127.0.0.1:4323/thumbnail-renderer`
- thumbnail jobs: `http://127.0.0.1:4324/healthz`

### Auth environment

Copy `.env.example` to `.env` and replace every credential placeholder. Copy `.env.local.example` to `.env.local` so local database commands cannot inherit the PlanetScale URL, then start local Postgres and migrate it:

```powershell
Copy-Item .env.local.example .env.local
```

```sh
pnpm db:setup
```

`db:setup` starts Docker Postgres, waits for its health check, and applies the Better Auth, control-plane, and sync schemas. The local database listens on `127.0.0.1:54329`.

Use the database commands independently when needed:

```sh
pnpm db:up
pnpm db:migrate
pnpm db:generate
pnpm db:check
pnpm db:shell
pnpm db:status
pnpm db:logs
pnpm db:restart
pnpm db:down
```

`db:generate` writes pending Kysely schema changes to `packages/auth/schema.sql`; when the live schema is current, it reports that no output is needed. The named Docker volume preserves data when the container stops.

For production, replace `DATABASE_URL` with the exact connection string from the PlanetScale Postgres Connect dialog. Keep `DATABASE_URL`, `BETTER_AUTH_SECRET`, the GitHub client secret, and service credentials out of Vite and Electron processes. Only public origins use the `VITE_` prefix. Set `AUTH_COOKIE_DOMAIN` to the shared DNS parent, such as `.canvas.example.com`, and keep the API, login, editor, and sync hosts inside that boundary. Better Auth then issues an HttpOnly, Secure, SameSite=Lax session cookie with `Path=/`. SameSite subdomains can send that cookie to both the HTTPS API and WSS sync handshake without putting a token in the WebSocket URL. Leave `AUTH_COOKIE_DOMAIN` empty for loopback development, where cookies remain host-only and HTTP-compatible.

`BETTER_AUTH_URL` is the public HTTPS origin of the hosted auth service. Set the GitHub OAuth app callback to `<BETTER_AUTH_URL>/api/auth/callback/github`. Set `DESIGN_EDITOR_AUTH_URL` to the same origin for the Electron main process. The renderer does not receive these credentials.

The canonical desktop callback is `com.comp-canvas.desktop://auth/callback`. It is handled by Electron after the hosted service completes GitHub sign-in; it is not the GitHub OAuth callback URL. The parser also accepts the equivalent authority-less URI emitted by some operating-system launch paths.

### File assets

The private R2 bucket is `comp-canvas-file-assets-dev`. The Worker owns file-scoped upload, read, copy, and thumbnail routes and asks the API to authorize every request. Local Worker development uses an R2 simulation; `wrangler r2 bucket list` verifies the real bucket without deploying the Worker.

The bundled fixture is disposable test data. Source-writing tests copy it to a temporary directory before applying changes.

## Current boundary

The first supported repository shape is a client React and Vite project. The Repository inspector can choose an existing local Git repository or clone a public GitHub repository into the desktop-managed `workspace/<repository-id>/repo` layout, then run the shared read-only shadcn scanner in an isolated utility process. The scanner discovers configured component and registry roots plus global CSS token provenance without executing repository scripts. Next.js server components and server-only imports remain unsupported until a dedicated adapter exists.

The hosted control plane supports account-scoped projects, files, canonical documents, live revision sync, revision conflicts, and private file assets. Clean remote edits update the open canvas immediately. A remote edit never replaces unsaved local work and instead surfaces a refresh conflict. Source writes still require desktop repository access and explicit review and Save approval. GitHub App repository grants, sharing, production ingress limits, automatic thumbnail rendering, and a live provider-to-desktop OAuth acceptance run remain unfinished capabilities.
