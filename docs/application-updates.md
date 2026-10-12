# Application update system

Comp Canvas uses separate update paths for the installed desktop application and the hosted browser application. A browser deployment never impersonates a desktop binary update.

## What we kept from the reference systems

| System | Strongest idea | Canvas decision |
| --- | --- | --- |
| Paper | Download desktop updates quietly, keep the final restart under user control, and check the hosted client separately | Adopted. Desktop downloads in the background and shows an explicit restart action. The browser compares `/version.json` and offers Refresh. |
| t3code | One main-process-owned, recoverable update state machine with narrow IPC and strict stable, nightly, and preview isolation | Adopted. Failures preserve the best recoverable state, actions serialize, and preview builds have no feed metadata. |
| Athas | Guard unsaved work before restart, verify exact release inputs, and assemble the complete release before publication | Adopted. Restart waits for document persistence, publication is tied to an authorized merged commit, and signing is required. |

Canvas deliberately does not copy Athas's duplicated renderer hooks, t3code's fail-open signing, or Paper's swallowed updater failures. Every failure has a visible state and reference.

## Runtime architecture

```text
Browser build                         Packaged desktop
version.json                          Electron main process
    |                                     |
web update service                    DesktopUpdateService
    |                                     |
Refresh notice                       narrow typed IPC
                                          |
                                   shared update notice
                                          |
                              explicit save-aware restart
```

The desktop state is one of `disabled`, `idle`, `checking`, `available`, `downloading`, `ready`, or `error`. The state lives in Electron main. Renderers can read it and request check, download, or install, but cannot set a feed URL, inject a package path, access credentials, or bypass update verification.

Checks run after a 15-second startup delay, every 15 minutes, and when the window regains focus after five minutes of staleness. Checks and downloads coalesce. Progress crosses the renderer boundary once per five percentage points. The package downloads in the background. Restart remains explicit.

Before installing, the renderer waits for any active gesture and document persistence to finish. A save error or ten-second timeout keeps the installer staged and reports a retryable failure. Electron disposes its owned services before `quitAndInstall`.

## Channels and storage

- `nightly` is built from the `staging` branch with version `X.Y.Z-nightly.RUN` and update URL `https://updates-staging.canvas.ripgrim.com/windows/x64`.
- `stable` is built from `main` with version `X.Y.Z` and update URL `https://updates.canvas.ripgrim.com/windows/x64`.
- Pull-request installers omit provider metadata and cannot join either feed.
- Nightly uses a separate application id and product name so it does not replace stable.

Each channel has a private R2 bucket behind the read-only update Worker. Installers and blockmaps are immutable versioned objects. `latest.yml` or `nightly.yml` is the only mutable pointer and is uploaded last. The Worker rejects writes and arbitrary object paths, supports byte ranges, disables caching for channel manifests, and caches versioned artifacts immutably.

The updater validates the SHA-512 recorded by electron-builder and the Windows Authenticode publisher. The release workflow refuses to publish without the certificate, password, expected publisher, R2 bucket, and scoped Cloudflare credentials.

## Release sequence

1. A non-draft pull request into `staging` or `main` runs database validation and creates an unsigned, non-updatable review installer.
2. Only an owner-triggered merge is eligible for release. Production must come from `staging`.
3. The merged revision is packaged with its channel version, generic update metadata, and protected signing identity.
4. The channel database migration completes.
5. GitHub Release publishes the exact workflow artifact.
6. The same installer and blockmap bytes are uploaded to R2.
7. The channel manifest advances last.

If a step before manifest publication fails, existing clients remain on the prior known-good release.

Use the manual `Update rollout` workflow to change eligibility after publication. The percentage is deterministic per installation. Set it to `0` to pause a channel, then advance through the chosen rings up to `100`. This changes only the small channel manifest and never rebuilds or replaces installer bytes.

## Required GitHub environments

Configure both the `staging` and `production` GitHub Environments. Production should require a reviewer.

Secrets:

- `DATABASE_URL`
- `WINDOWS_CERTIFICATE`
- `WINDOWS_CERTIFICATE_PASSWORD`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Variables:

- `WINDOWS_PUBLISHER`
- `UPDATE_BUCKET`
- `UPDATE_ROLLOUT_PERCENTAGE` for the initial ring, normally `100` for nightly and a smaller reviewed value for stable

Use `comp-canvas-updates-staging` for the staging bucket and `comp-canvas-updates-production` for production. The Cloudflare token should be limited to object writes for the matching bucket and deployment of the matching Worker environment.

## Verification

Run:

```powershell
pnpm --filter @canvas/desktop typecheck
pnpm --filter @canvas/desktop exec vitest run tests/update-machine.test.ts tests/update-service.test.ts tests/policy.test.ts
pnpm --filter @canvas/web typecheck
pnpm --filter @canvas/web exec vitest run src/features/updates/application-update-service.test.ts
pnpm --filter @canvas/update-service typecheck
pnpm --filter @canvas/update-service test
pnpm test:release-workflows
```

A release is not fully verified until a disposable Windows VM installs the prior signed version, opens and edits a document, updates to the candidate, relaunches, and confirms document persistence, authentication recovery, collaboration reconnection, and the new version. That signed N to N+1 test remains a release gate to automate before calling desktop updates production-ready.
