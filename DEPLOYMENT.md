# Deployment

## Release branches

`staging` is the persistent pre-production branch and `main` is the production branch. A push to `staging` updates staging. The `Promote staging` GitHub workflow creates one pull request from `staging` into `main`, or leaves the existing release pull request in place when one is already open. Nothing in the workflow pushes to `main` directly.

The public staging entry point is `staging.canvas.ripgrim.com`. Supporting services use flat internal names such as `api-staging.canvas.ripgrim.com`; users do not need to navigate to them. The preview runtime remains on a separate origin because it is an iframe security boundary. `deploy/environments.json` is the non-secret source of truth for both origin sets.

Staging must use its own database credentials, Better Auth secret, R2 bucket, collaboration secrets, and service tokens. Never populate a staging deployment with production database or storage credentials. Main remains the only production deployment branch.

Copy `.env.staging.example` to the ignored `.env.staging` file and fill the empty credentials before configuring the remote environment. Keep `AUTH_COOKIE_DOMAIN` empty and set `AUTH_COOKIE_PREFIX=comp-canvas-staging`. The distinct prefix prevents the production parent-domain cookie from shadowing the staging host-only cookie. The editor origin owns browser auth and proxies `/api/*` to the API project, so browser requests keep the staging session cookie. Register `https://staging.canvas.ripgrim.com/api/auth/callback/github` as the staging social-login OAuth callback. Use a separate staging GitHub App for repository installations because a GitHub App has one webhook URL and staging must not send repository events through production.

Each independently deployed HTTP surface has its own Vercel project. Run `pnpm vercel:check` to validate the manifest and live project settings. Run `pnpm vercel:setup` to connect each staging branch domain, disable Vercel Authentication so phone and external-device testing reaches the product login, and enable Git deployments without creating a deployment itself. Vercel treats `main` as production and `staging` as a persistent preview branch. Pushing either branch publishes its corresponding environment after the remote setup has been explicitly approved and applied.

Run `pnpm vercel:env:staging:check` to validate `.env.staging` without printing values or changing Vercel. After approval, `pnpm vercel:env:staging:apply` uploads only the variables declared for each project as Preview variables scoped to the `staging` branch. It sends values over standard input so secrets are not placed in command arguments.

Every Vercel surface rejects automatic deployments from branches other than `main` and `staging`. Ordinary feature branches are validated locally and through GitHub checks without creating five unrelated preview deployments.

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
binding, placement, storage class, lifecycle rules, and expected Worker state.
`pnpm cloudflare:check` verifies the remote preview resource without changing
it. The check rejects a missing preview Worker, disabled or unexpected
expiration rules, public bucket access, bucket-level custom domains, and
preview or production bucket collisions. It allows objects after deployment
because staging uploads are real user data. `pnpm cloudflare:setup` creates or
reconciles the bucket without uploading an object. Deploy the staging Worker
after its secrets exist with `pnpm cloudflare:deploy:staging`. Local development
remains on Wrangler's R2 simulation. Remote preview uses
`comp-canvas-file-assets-dev`; production uses the separate
`comp-canvas-file-assets-production` bucket.

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

Revision sync uses a public admission Worker, a private generation coordinator,
and a private Cloudflare room Container. PostgreSQL remains the durable document
and operation-log authority. Staging uses the `lite` Container class, one stable
Container object per file generation, a ten-minute inactivity timeout, and no
public runtime route. Production sync remains undeployed.

Local development exposes the public Worker at `ws://127.0.0.1:4321`, the room
runtime at `http://127.0.0.1:4325`, and the private coordinator at
`http://127.0.0.1:4326`. The root command writes separate ignored `.dev.vars`
files so the API admission token never reaches the coordinator and the room
ticket secret never reaches the public Worker. Do not put either value in a
`VITE_` variable or a WebSocket URL.

Before the first staging deployment, upload `DATABASE_URL` and
`SYNC_ROOM_TICKET_SECRET` to `comp-canvas-sync-runtime-preview`, upload the same
ticket secret plus `SYNC_COORDINATOR_INTERNAL_SECRET` to the preview coordinator,
and upload the same coordinator secret plus
`COLLABORATION_ADMISSION_SERVICE_TOKEN` to the preview admission Worker. Keep
the three trust boundaries separate. Then run `pnpm sync:deploy:staging`; it
deploys the private runtime first, the coordinator second, and the public Worker
last. The public route is `sync-staging.canvas.ripgrim.com`. No production sync
configuration is declared.

