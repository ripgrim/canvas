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

Run the desktop development build:

```sh
pnpm dev
```

### Auth environment

Copy `.env.example` to `.env` and replace every credential placeholder. Copy `.env.local.example` to `.env.local` so local database commands cannot inherit the PlanetScale URL, then start local Postgres and migrate it:

```powershell
Copy-Item .env.local.example .env.local
```

```sh
pnpm db:setup
```

`db:setup` starts Docker Postgres, waits for its health check, and applies the Better Auth schema. The local database listens on `127.0.0.1:54329`.

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

For production, replace `DATABASE_URL` with the exact connection string from the PlanetScale Postgres Connect dialog. Keep `DATABASE_URL`, `BETTER_AUTH_SECRET`, and the GitHub client secret in the hosted auth process only.

`BETTER_AUTH_URL` is the public HTTPS origin of the hosted auth service. Set the GitHub OAuth app callback to `<BETTER_AUTH_URL>/api/auth/callback/github`. Set `DESIGN_EDITOR_AUTH_URL` to the same origin for the Electron main process. The renderer does not receive these credentials.

The canonical desktop callback is `com.comp-canvas.desktop://auth/callback`. It is handled by Electron after the hosted service completes GitHub sign-in; it is not the GitHub OAuth callback URL. The parser also accepts the equivalent authority-less URI emitted by some operating-system launch paths.

The bundled fixture is disposable test data. Source-writing tests copy it to a temporary directory before applying changes.

## Current boundary

The first supported repository shape is a client React and Vite project. The Repository inspector can choose an existing local Git repository or clone a public GitHub repository into the desktop-managed `workspace/<repository-id>/repo` layout, then run the shared read-only shadcn scanner in an isolated utility process. The scanner discovers configured component and registry roots plus global CSS token provenance without executing repository scripts. It is not yet wired into the component catalog or preview runtime, so shadcn insertion and two-way sync are not represented as complete. Next.js server components and server-only imports remain unsupported until a dedicated adapter exists. `packages/auth` contains the shared Better Auth server factory and the Electron callback/session boundary. Sign-in is not represented as working until a hosted service, PlanetScale Postgres database, GitHub OAuth app, and real round-trip acceptance tests exist. GitHub App repository access and sharing remain separate unfinished capabilities.
