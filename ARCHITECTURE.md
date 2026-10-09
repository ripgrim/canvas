# Architecture

Design editor separates privileged desktop capabilities, untrusted repository work, live preview, authored UI, and hosted account services.

## System map

```text
Electron main
  |-- typed preload bridge
  |     `-- Vite React DOM editor renderer
  |-- local repository engine process
  |     |-- indexer and identity graph
  |     |-- Vite preview build workers
  |     |-- TypeScript and ts-morph analysis
  |     |-- Babel and Recast patch planner
  |     `-- PostCSS token planner
  `-- system browser auth and main-process token vault

Isolated preview origin
  `-- imported user React code, no privileged preload

TanStack Start hosted control plane
  |-- Better Auth server integration
  |-- project, share, and sync APIs
  `-- PostgreSQL
```

The renderer sends typed commands. It never receives arbitrary filesystem, shell, token, or network authority. The repository engine validates every operation against the active project grant.

## Monorepo shape

Use a pnpm workspace for first-party source. A suggested boundary is:

```text
apps/
  desktop-main/
  desktop-renderer/
  control-plane/
packages/
  auth-contracts/
  command-model/
  design-system/
  editor-canvas/
  editor-shell/
  identity-graph/
  ipc-contracts/
  preview-protocol/
  repo-engine/
  source-patches/
  test-fixtures/
```

Do not absorb imported repositories into this workspace. Preserve their package manager, lockfile, scripts, and source conventions.

## Electron boundary

Create windows with `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`. Apply a restrictive CSP and deny unexpected navigation, popups, permissions, downloads, and protocol handlers.

Expose an allowlisted preload API with request and response schemas. Prefer task-level operations such as `openProject`, `readProjectSummary`, `preparePatch`, and `applyApprovedTransaction` over generic `readFile`, `writeFile`, `exec`, or `fetch` functions.

For every IPC call validate:

- sender frame and expected origin;
- schema and size limits;
- authenticated desktop session where needed;
- active project grant;
- canonical path and symlink containment;
- operation capability;
- transaction or build generation.

## Repository engine

Run repository analysis and source preparation outside the renderer. The engine owns a project grant rooted at one canonical local directory. All reads and writes stay within the grant after real-path and symlink checks.

Do not run install hooks, repository scripts, plugins, or arbitrary configuration code during indexing. A separate trust flow lists the exact command, working directory, network policy, writable paths, and environment variables. Strip inherited secrets. Use an OS sandbox or constrained worker for approved execution.

Detect `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, and other supported lockfiles. Never replace or normalize them as part of connection.

## Preview pipeline

Create an adapter contract with these stages:

1. Detect repository and framework.
2. Resolve safe entry points and design-system roots.
3. Build a generated preview entry outside user source.
4. Compile in a constrained worker.
5. Serve assets on an isolated preview origin.
6. Mount the selected component into a preview-owned React root.
7. exchange only a narrow preview protocol for selection, bounds, props, diagnostics, and commands.
8. Dispose the root, listeners, server, watcher, and worker when the preview closes.

User code never runs in Electron main or the editor renderer. The isolated preview has no auth or filesystem preload. Use origin checks and validate every message. Sandboxed iframes help isolate browser content but do not make Node.js execution safe.

Assign every build a monotonically increasing generation. Only the latest requested generation may update the preview. If generation 7 finishes after generation 8, discard 7. Invalid generation 8 retains generation 6 or 7 only if it was the last confirmed good preview and labels the view stale with current diagnostics.

## Adapter support

Implement client React and Vite first. The adapter must preserve repository providers, CSS entry points, portals, and supported asset behavior. Do not call a static JSX recreation a successful adapter.

For Next.js and other server-first systems, detect server-only imports, RSC boundaries, server actions, and framework loaders. Report an explicit limitation or use a later dedicated adapter. Never inject `use client` or rewrite boundaries without an approved transform.

## Identity graph

The graph uses an opaque stable `componentId` and mutable bindings:

```ts
type ComponentBinding = {
  componentId: string
  repositoryId: string
  packageId: string | null
  path: string | null
  exportName: string | null
  symbolFingerprint: string | null
  sourceSpans: readonly SourceSpan[]
  adapterId: string
  verifiedRevision: string | null
  status: 'bound' | 'missing' | 'ambiguous' | 'unsupported'
}
```

The persistent ID is not a hash of commit, path, export, or source position. Revision and source spans are evidence, not identity.

Reconciliation order:

1. Exact current binding with matching symbol fingerprint.
2. Export graph and file move evidence.
3. Structural symbol match with repository history evidence.
4. One high-confidence candidate, recorded as a proposed rebind.
5. Multiple candidates become ambiguous and require user selection.
6. No candidate becomes missing. Retain the old identity and canvas reference for repair.

A delete never silently rebinds to a same-named symbol. A rename preserves the ID only after verified reconciliation.

## Source and style provenance

Map a rendered element to its React fiber or adapter record, component identity, instance path, prop source, slot, and source spans without exposing framework internals as a durable API. Treat the mapping as adapter-versioned evidence.

Each editable value has provenance:

```ts
type EditableProvenance = {
  kind: 'prop' | 'variant' | 'token' | 'class' | 'css-module' | 'inline' | 'inherited' | 'computed'
  writable: boolean
  source: SourceSpan | null
  confidence: 'verified' | 'ambiguous' | 'unsupported'
  reason: string | null
}
```

Computed values, runtime string construction, unknown CSS-in-JS evaluation, and ambiguous cascade matches are not writable. Surface the reason. Do not select a nearby literal because it looks equivalent.

## Source patch pipeline

Use TypeScript and `ts-morph` to resolve symbols, imports, exports, and types. Use Babel plus Recast to make localized TSX syntax changes while preserving unrelated formatting. Use PostCSS to find and patch canonical custom-property declarations.

For every transaction:

1. Record file paths and SHA-256 base hashes.
2. Parse from the captured bytes.
3. Plan edits with source spans and semantic targets.
4. Materialize candidate files in a staging directory.
5. Parse, typecheck, build the relevant preview, and run targeted tests.
6. Create a unified diff and semantic summary.
7. Bind approval to the transaction digest.
8. Re-read and hash every source file.
9. Abort on mismatch.
10. Replace all files atomically where supported, or use a journal and restore every original on failure.
11. Re-index and reconcile identities.

The transaction digest covers base hashes, patch bytes, adapter version, scope, and validation configuration. Any difference invalidates approval.

Promotion creates a new component module with imports of existing atoms, adds the smallest required export, and updates only explicit composition bindings. It must not paste rendered DOM or copy atom implementation.

## Command and state model

Use Zustand for serializable editor state and explicit command objects for mutations. Commands include preconditions, affected persistent IDs, transient preview changes, optional source plans, and inverse intent.

Do not use effects to coordinate stores. React reads external stores through a genuine `useSyncExternalStore` adapter with stable snapshots. Services own subscriptions and provide `start`, `stop`, and `dispose`. Route and query loaders own fetch timing. User actions call commands directly.

Undo before Save reverses transient state. Undo after Save prepares a checked reverse source transaction using the prior semantic intent and current file hashes. External changes can turn the reverse operation into Review update or Conflict.

## Auth and control plane

Use Better Auth with PostgreSQL in TanStack Start server modules. TanStack Start is isomorphic by default, so database and secret imports must be protected by package exports and server-only entry points, not by atomic component level.

Desktop login flow:

1. Renderer asks main process to begin sign-in.
2. Main opens the system browser to the hosted Better Auth flow with state and PKCE where supported.
3. The hosted callback verifies the request and redirects to a registered application link containing a one-time result.
4. Main validates the application link and exchanges the result.
5. Main stores refresh and access material in OS-protected storage.
6. Renderer receives only session display data and allowed commands.

Do not copy Better Auth example lifecycle code unchanged if it violates the authored no-effect rule. Adapt the flow to explicit commands and owned services.

All APIs resolve the authenticated actor and authorize the exact organization, project, repository, share, and operation. A route guard alone is insufficient. Share links store hashed secrets where applicable, explicit role, expiry, status, creator, and revocation time.

Pin a reviewed TanStack Start release candidate version. Record an upgrade and rollback decision because the framework is not yet declared stable in the referenced overview.

## First-party UI enforcement

Create lint rules using a TypeScript-aware AST:

- `pages-compose-components`: in configured page or route globs, reject intrinsic JSX elements, `className`, Tailwind-like strings, and feature implementation calls. Allow framework-required route objects and metadata exports by exact AST shape.
- `no-inline-feature-copy`: reject user-facing JSX text and string props in pages. Permit non-user identifiers, test IDs, route IDs, and accessibility values sourced from feature copy modules.
- `atomic-import-direction`: atoms import no higher layers, molecules import atoms, organisms import atoms and molecules, pages import higher layers and approved route contracts.
- `no-effect-escape`: resolve imports, namespace members, aliases, re-exports, wrapper hooks, alternate effect hooks, class lifecycles, and known render-time side effects.
- `runtime-boundary`: reject server package imports from browser entry points and client package imports from server-only modules where disallowed.

Framework exceptions live in a reviewed configuration with rule ID, file glob, exact syntax, reason, owner, and removal condition. They are not blanket disables.

## Component system

Use shadcn/ui consistently with Base UI. Do not mix Radix and Base UI implementations of the same primitive without a documented adapter reason. Root discovery can recognize both Base UI and Radix wrappers in imported repositories.

First-party design-system packages contain semantic atoms, named layout primitives, typography primitives, molecules, and organisms. Pages contain composition only. Feature copy modules sit with features and provide typed messages to display components.

## Security threat cases

Test and defend against:

- renderer asking preload to read outside the granted repository;
- symlink escape after grant;
- message from an unexpected frame or origin;
- preview requesting filesystem or auth capability;
- repository config that executes during import;
- install script reading inherited credentials;
- malicious application link or replayed login state;
- user without project membership calling a valid API directly;
- revoked share continuing over an existing subscription;
- stale approved patch applied after an external edit;
- older build overwriting the newest preview;
- oversized or cyclic preview messages;
- disposed preview retaining listeners or roots.

## Observability

Use correlation IDs for builds, transactions, IPC requests, auth attempts, and API requests. Redact source content, paths beyond project-relative form, tokens, cookies, secrets, and user code from default telemetry. Local logs clearly state what remains on device and can be opened by the user.
