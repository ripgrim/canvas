# Deployment

Each independently deployed HTTP surface has its own Vercel project. Run `pnpm vercel:check` to validate the manifest and live project settings. Run `pnpm vercel:setup` to create and link the projects without deploying them. Git-triggered deployments remain disabled until release approval, so a repository push cannot publish these projects early.

| Service | Project | Host | Runtime |
| --- | --- | --- | --- |
| Editor | `comp-canvas-web` | `canvas.ripgrim.com` | Vercel static output |
| Login | `comp-canvas-login` | `login.canvas.ripgrim.com` | Vercel static output |
| API and auth | `comp-canvas-api` | `api.canvas.ripgrim.com` | Vercel Node function |
| Preview | `comp-canvas-preview` | `preview.canvas.ripgrim.com` | Vercel static output |
| Thumbnail renderer | `comp-canvas-thumbnail-renderer` | `thumbnails.canvas.ripgrim.com` | Vercel static output |
| Assets | `comp-canvas-file-assets-production` | `assets.canvas.ripgrim.com` | Cloudflare Worker and private R2 |
| Sync | `comp-canvas-sync` | `sync.canvas.ripgrim.com` | Cloudflare Worker and Durable Objects |
| Thumbnail jobs | Not created on Vercel | Private only | Private browser worker |
| Desktop | Not created on Vercel | Native app | Electron release |

The preview host serves the production composition runtime built from the verified component registry. It remains isolated from the authenticated editor origin and does not expose filesystem or auth capabilities.

Vercel environment names are declared in `deploy/vercel-projects.json`. Values stay in Vercel project settings and are never copied into source. When a domain is chosen, map separate hosts for the editor, login, API, thumbnail renderer, sync, and assets. Update the origin and cookie-domain variables together before any deployment.

The thumbnail renderer Vercel build generates and verifies its component registry before Vite starts. The resulting fingerprint must be copied to the API project's `CANVAS_VERIFIED_REGISTRY_FINGERPRINT` setting for the same release. `pnpm test:vercel-builds` executes every declared Vercel build from its configured project root and verifies its output directory.

`pnpm dev` starts Postgres, migrations, every local service, and Electron. `pnpm dev:cloud` starts the same stack without Electron. Both commands generate the ignored local verified component registry before launching the preview and thumbnail renderer. `pnpm test:dev-stack` starts all services, verifies each readiness contract, confirms ports 4318 and 4323 consume the same nonempty registry fingerprint, and exits. `pnpm dev:check` validates the topology and reports occupied ports without starting anything.

`pnpm verify` runs the repository checks that do not require Docker, including missing-manifest and stale-integrity negative controls for the registry. Its build path regenerates the manifest first so a clean checkout does not depend on generated files. `pnpm test:postgres` starts and migrates local Postgres before running the control-plane and sync transaction suites. `pnpm verify:local` runs both groups and finishes with the complete local stack smoke test.

`pnpm test:home-auth-parity` starts isolated web and login fixtures on ports 4417 and 4419, captures the required desktop and compact viewport evidence, and shuts both fixtures down. `pnpm infra:check` runs the read-only live Vercel and Cloudflare gates. It never deploys either platform.

## Cloudflare assets

`deploy/cloudflare-r2.json` is the source of truth for the private R2 buckets,
binding, placement, storage class, and lifecycle rules. `pnpm cloudflare:check`
verifies the remote preview resource without changing it. The check rejects a
non-empty setup bucket, any deployed Worker environment, disabled or unexpected
expiration rules, public access, custom domains, and preview or production
bucket collisions. `pnpm
cloudflare:setup` creates or reconciles that resource without deploying the
Worker or uploading an object. Local development remains on Wrangler's R2
simulation. Remote preview uses `comp-canvas-file-assets-dev`; production uses
the separate `comp-canvas-file-assets-production` bucket.

The bucket has no public `r2.dev` URL and no direct custom domain. Browser
traffic must pass through the Worker authorization boundary. The managed
marker rules expire `thumbnail-claims/` after eight days and
`thumbnail-quota/` after one day. Cloudflare's default seven-day incomplete
multipart rule remains unchanged.

Production browser traffic uses `assets.canvas.ripgrim.com`. The Worker keeps
the bucket private and performs authorization before every object operation.
Deploy it only with explicit release approval using
`pnpm --filter @canvas/workers exec wrangler deploy --env production`.

## Cloudflare sync

Revision sync is being cut over to a public admission Worker, a private
generation coordinator, and an authoritative room runtime. PostgreSQL remains
the durable document and operation-log authority. Hosted sync remains disabled
until the Container manager and placement gate are complete.

Local development exposes the public Worker at `ws://127.0.0.1:4321`, the room
runtime at `http://127.0.0.1:4325`, and the private coordinator at
`http://127.0.0.1:4326`. The root command writes separate ignored `.dev.vars`
files so the API admission token never reaches the coordinator and the room
ticket secret never reaches the public Worker. Do not put either value in a
`VITE_` variable or a WebSocket URL.

The checked-in Wrangler configurations and dry-run builds do not create a
Container manager, attach the custom domain, upload secrets, run migrations, or
deploy code. Those release operations require explicit approval.

