# Acceptance tests

These tests define release evidence. A result is valid only when it uses real fixtures and observable boundaries. Mock-only demonstrations, skipped tests, and assertions derived from production logic do not pass.

## Paper parity program

The detailed behavior matrix and evidence inventory live in `docs/research/paper-parity-integration.md`. These IDs are release gates, not implementation milestones.

### PAPER-TEXT-001 through PAPER-TEXT-008

Verify the stored text model and migration, preview CSS, legacy visual preservation, creation, direct editing, keyboard behavior, resize modifiers and sizing modes, inspector fidelity, semantic undo, and live two-client publication. Use independently authored expected CSS and geometry. Negative controls must reject text-only fields on non-text nodes, malformed typography, stale semantic commits, and read-only edits. Capture screenshots of editing, selection, and every inspector state in light and dark modes.

### PAPER-FLEX-001 through PAPER-FLEX-008

Verify Add flex, Wrap in flex, Remove flex, inference, absolute-child preservation, flow and absolute transitions, the Paper-order inspector, alignment matrix keyboard behavior, gaps, padding, baseline modes, reorder, duplicate, modifier drops, rotated resize, one semantic undo, and live two-client convergence. Negative controls must catch world-geometry drift, an absolute child entering flow, direction changes that preserve wrapping, a final commit that differs from the final live state, and more than one undo entry for one gesture.

### PAPER-CLIP-001 through PAPER-CLIP-008

Verify MIME precedence, versioned internal payloads, editable-target bypass, SVG sanitization, image conversion and limits, same-file and cross-file insertion, asset and token reconciliation, placement, Paste on top, Paste to replace, partial multi-image success, one semantic batch, one undo entry, and live two-client convergence. Negative controls must reject scripts, event handlers, external SVG references, over-limit payloads, invalid tree relationships, private asset fields, unauthorized cut or replace, and a paste that commits before every required asset is verified.

## Evidence rules

- Record fixture revision, platform, tool versions, and relevant hashes.
- Compare against independently written expected values or checked fixture bytes.
- Critical tests include a negative control or targeted mutation that must fail.
- Keep screenshots, recordings, diffs, and diagnostics with the test result.
- Label unsupported adapters as unsupported. Do not rerun against a different adapter and claim the requested case passed.

## Pull request interaction evidence

### PR-EVIDENCE-001: Deterministic planning

Map both sides of every changed path through the trusted capability registry. The same changes in any order produce identical canonical plans. Unmapped paths and visual capabilities without scenarios fail.

### PR-EVIDENCE-002: Strict manifest

Accept only the versioned manifest schema, safe relative paths, unique scenarios, unique assets, content hashes, exact run identity, and explicit nonvisual reasons. Reject unknown keys and unsafe paths.

### PR-EVIDENCE-003: Browser capture

Run the transient-move pilot through public automation actions and real pointer input. Capture before, held, and after screenshots plus a recording. Verify preview geometry, HUD geometry, committed state, and viewport stability independently.

### PR-EVIDENCE-004: Electron capture

Deferred until the browser pilot is stable. Do not report Electron evidence from a browser adapter.

### PR-EVIDENCE-005: Deterministic media

Verify the pinned FFmpeg tools by size and SHA-256. Normalize the browser recording to VP9 WebM, preserve observed cadence, decode the full result, reject blank or static output, enforce 30 seconds and 9 MiB, and extract a PNG poster.

### PR-EVIDENCE-006: Relevance gate

Run only scenarios selected by the deterministic plan. Nonvisual changes require a concrete registry reason. New observable behavior cannot bypass capture.

### PR-EVIDENCE-007: Idempotent publication

Replace only the managed PR evidence block. Preserve unrelated PR prose. Repeating the same publication performs no PR body write.

### PR-EVIDENCE-008: Rendered PR verification

Publish content-addressed media through the read-only evidence service. Re-read the PR and verify its raw body, rendered HTML, managed key, and every media URL.

### PR-EVIDENCE-009: Adoption boundary

When the evidence system is introduced on an existing pull request, diff from the trusted adoption commit until the target branch contains it. Reject a head that does not contain that commit. Once adopted, use the pull request base normally.

### PR-EVIDENCE-010: Frame wiggle and flex

Draw a 500 by 500 frame through real pointer input, move it around a closed path, set its fill to red through the inspector, and add flex through the keyboard command. During every held move, verify that preview and HUD geometry agree while stored geometry remains unchanged. After release, independently verify the stored size, fill, flex layout, screenshots, and recording.

### PR-EVIDENCE-011: Typed overlay and evidence crops

Create a frame through public automation actions. Verify typed overlay bounds, eight resize handles, four rotation handles, and stale-overlay rejection after deselection. Capture a two-times compositor screenshot and an independent poster with node-relative padding and the current theme background. Record the moving node from real compositor frames at two-times scale. Verify motion remains the default, compositor capture requires a bounded crop, and normalization preserves the already-composited dimensions.

### PR-EVIDENCE-SEC-001: Untrusted capture boundary

The pull-request workflow has read-only contents, no secrets, no environment, no persisted credentials, and no write permission.

### PR-EVIDENCE-SEC-002: Trusted publisher boundary

The workflow-run publisher checks out only the default branch, never executes pull-request code, downloads the exact upstream artifact, rejects extra archive entries and symlinks, and validates repository, PR, base, head, run, attempt, registry, files, scenarios, assertions, bytes, and hashes before writing.

### PR-EVIDENCE-PERF-001: Bounded evidence cost

Use one browser worker, one scenario per selected capability set, bounded process output, bounded media, no fixed waits, and no FFmpeg binary in the application package.

### PR-EVIDENCE-NEG-001: Evidence mutation controls

Mutate one tool hash, media hash, manifest identity, scenario assertion, archive path, and media origin. Each mutation must fail before publication.

## P0 end-to-end

### AT-P0-001: Local login composition and promotion

Fixture: a client React and Vite repository with real `Input`, `Button`, `Card`, and `Label` atoms plus canonical tokens in `globals.css`.

1. Open the local folder.
2. Confirm phase progress comes from actual engine events and contains no invented percentage.
3. Discover the four atoms from source.
4. Place real instances and compose a login screen.
5. Change typed props, reorder children, use a named slot, resize the frame, and switch theme.
6. Select shared `Label` padding scope.
7. Review the exact minimal patch and Save.
8. Edit a token and confirm the prepared patch targets the canonical `globals.css` declaration.
9. Promote the composition into a named code component.
10. Confirm the new component imports the four existing atoms and the canvas rebinds to its persistent ID.

Pass evidence:

- runtime behavior and providers still work;
- no live component was flattened to anonymous DOM;
- Label change alters only the expected source span;
- token change alters only the canonical declaration;
- promotion adds the focused module and minimum export edit;
- reopening the project resolves the same persistent identities.

Negative control: mutate the fixture so two `Label` exports are structurally ambiguous. Save must be blocked until the user chooses a binding.

### AT-P0-002: GitHub import parity

Import the same fixture through GitHub using an approved repository selection. Verify discovery, isolated preview, read-only first state, and source review behavior. Do not push or open a pull request.

Negative control: select a repository the signed-in actor cannot access. The server and desktop both deny import without revealing repository metadata.

## Repository discovery and synchronization

### AT-REPO-CONNECT-001: Local and managed repository connection

From the desktop Repository panel, cancel the folder picker, choose a nested folder inside a real local Git repository, clone a public GitHub repository, relaunch, and scan both sources. The local connection resolves to the repository root. The clone exists only at the desktop-managed `workspace/<opaque repository id>/repo` path. The renderer receives only the opaque id, display name, source kind, and scan result. It never receives a canonical filesystem path, Git credentials, or an arbitrary command surface.

Negative controls: path-like clone owner/name values, extra IPC keys, a non-Git local folder, an invalid sender frame, a clone failure, and a scanner source-link escape must fail. A failed clone removes only its newly allocated managed workspace.

### AT-SCAN-001: shadcn source discovery

Scan checked-in Vite and monorepo fixtures with root and nested `components.json` files, configured UI aliases, `components/ui`, shared `packages/ui`, and local registry sources. Also scan a package-bound monorepo app with `src/components/ui` and `src/styles.css` but no `components.json`; it must be reported as automatically detected and expose the same component and token evidence. Compare the discovered package, path, export, declaration form, props, and slots with an independently written manifest. Scanning must not run package hooks, repository scripts, plugins, or imported component code.

Negative controls: a repository script that writes a marker never runs; a source link escaping the repository grant is rejected; anonymous defaults and server-only exports are reported unsupported rather than presented as usable components. A connected repository without a manifest or package-bound `components/ui` root is shown as unsupported, not as a successful `0 components and 0 tokens` scan.

### AT-TOK-001: shadcn token provenance

Parse a checked-in `globals.css` fixture containing base and dark tokens, `@layer`, `@theme inline`, OKLCH values, aliases, and unrelated local variables. Assert exact selector, at-rule, theme, alias, path, and source-location evidence. Prepare one canonical token edit and compare the full file with independent golden bytes.

Negative controls: duplicate canonical declarations, an alias cycle, a runtime-computed value, and stale source bytes each block Save without changing a file.

### AT-REPO-TOKEN-001: Importable repository color catalog

Scan base, dark, alias, color, spacing, radius, and composite CSS custom properties. Verify that one compact row represents each color property across themes, simple aliases resolve to a real swatch, and non-color values remain excluded from the import list. In a browser, verify a light color alias does not inherit the canvas normalizer's black sentinel and a font alias chain does not become an importable color.

Long component and token catalogs render inside independently scrollable inset list surfaces. Verify each surface has real vertical overflow and wheel and keyboard scrolling remain inside the nested viewport. When two or more tokens are selected, the bulk import action spans the inset surface at its bottom edge, remains outside the scrolling rows, and uses a surface-colored upward fade so the final visible row recedes beneath it.

Negative controls: alias cycles and unsupported composite values must not receive an invented color preview or an enabled import action.

### AT-REPO-TOKEN-002: Atomic repository token import

Import one token from its row, then select two unimported tokens and use the bulk action. Verify that Select all selects only importable tokens, Shift-click selects the contiguous range from the last token interaction, and token-row text cannot be selected. Verify that clicking a selectable row toggles its checkbox, clicking the checkbox still toggles exactly once, and nested Import actions do not also toggle row selection. Verify that the file receives source-backed color tokens with stable CSS property bindings, one bulk action creates one undo entry, imported properties cannot be duplicated, and Undo removes the whole bulk import together.

### AT-COMP-001: real TypeScript components

Index a real shadcn Button with static variants, Card parts, Input, and a stateful portal Dialog. Insert source-bound instances and verify actual prop types, variants, slots, providers, interaction, and portal behavior in the isolated preview. A static copied JSX version must fail the behavior and identity assertions.

### AT-SYNC-001: incremental pull

Record component and token identities, then make a non-semantic edit, an implementation edit, a verified move and rename, an ambiguous replacement, a token edit, and a temporary parse failure. Confirm changed-file-only indexing, stable identity only where evidence supports it, explicit missing or ambiguous states, and last-good preview retention.

### AT-SYNC-002: reviewed push

Prepare a prop or variant edit and a token edit from semantic source evidence. Confirm exact golden diffs and no write before explicit approval. Then change the same semantic target externally and exercise Keep source, Keep canvas change, and Edit manually. Every choice produces a fresh diff and approval digest. Inject a failure after the first file replacement and verify byte-for-byte rollback.

## Identity

### AT-ID-001: Identity survives a commit

Record the component ID, commit a non-semantic source edit in the fixture, re-index, and confirm the same ID remains bound. This proves identity is not the commit hash.

Negative control: a test build that derives ID from commit must fail the assertion.

### AT-ID-002: Identity survives move and rename

Move the component file and rename its export while preserving symbol structure and export graph evidence. Reconcile to the same ID and record the new mutable binding.

### AT-ID-003: Delete and ambiguous reconcile

Delete one managed component. Confirm its ID becomes missing and source writes stop. Then add two plausible replacements. Confirm the state becomes ambiguous and no silent rebind occurs.

## Source transactions

### AT-SRC-001: Hash check invalidates approval

Prepare and approve a patch, then change one source byte outside the editor. Save must stop before any write and require a new review.

### AT-SRC-002: Multi-file rollback

Prepare a two-file promotion. Inject a failure after the first staged replacement. Confirm both files match their original SHA-256 hashes and the UI reports rollback.

Negative control: disable the rollback path in a targeted mutation. The test must fail by detecting a changed hash.

### AT-SRC-003: Minimal TSX patch

Change one `Label` padding value. Assert against a checked golden diff written independently from the patch function. Verify unrelated imports, formatting, comments, JSX, and line endings remain unchanged.

### AT-SRC-004: Canonical token patch

Change one CSS custom property bound to multiple instances. Confirm PostCSS changes the canonical `globals.css` declaration and no copied instance style.

Negative control: give an equivalent computed runtime color with no writable provenance. Save must remain disabled.

### AT-SRC-005: Conflict choices

Make an external edit to the same semantic target after a transient canvas change. Verify Keep source, Keep canvas change, and Edit manually each show a fresh resulting diff and require approval.

### AT-SRC-006: Undo after external edit

Save a source patch, modify the affected source externally, then select Undo. Confirm the editor prepares a checked reverse patch or conflict. It must not restore stale bytes.

## Preview and lifecycle

### AT-PRV-001: Real component execution

Use a fixture component with state, a provider, a portal, keyboard behavior, and CSS. Confirm all operate in the isolated preview and the canvas retains component and slot identity.

Negative control: render a static copied JSX tree. The behavior and identity assertions must fail.

### AT-PRV-002: Stale build rejection

Delay build N, complete build N+1, then finish N. Confirm N never replaces N+1.

### AT-PRV-003: Invalid code retains last good preview

Introduce a parse error. Confirm diagnostics correspond to the current source and the last good preview remains visibly marked as stale. Fix the error and confirm the newest build replaces it.

### AT-PRV-004: Disposal

Open and close the same preview repeatedly. Verify React roots, watchers, ports, listeners, and owned services are disposed. Assert memory against the documented budget with caches identified.

### AT-PRV-005: State preservation disclosure

Apply one compatible edit and one incompatible tree edit. Verify compatible state may remain when supported, and incompatible state reset is disclosed. The product never promises universal preservation.

## Canvas and editor breadth

### AT-CAN-001: Selection and hierarchy

Verify shallow select, deep select, parent and child traversal, multiselect, lock, hide, duplicate, reorder, frame selection, ungroup, and exact layer-tree targeting using mouse and keyboard.

Layer visibility and lock actions appear on row hover or their own keyboard focus. A hidden node remains identified by reduced name and type-icon opacity. A direct lock also locks descendants, removes canvas hit targets and resize controls, and prevents layer drag reorder for that node. The locked node remains selectable from Layers and its inspector properties remain editable.

### AT-CAN-002: Layout and snap

Verify fixed, fit, fill, padding, gap, direction, alignment, wrap, absolute position, clipping, snap guides, align, distribute, nudge, large nudge, and frame resize.

Width and Height expose their valid sizing modes from controls attached to the value fields. A freeform or absolute item does not claim flex-only sizing. A flex item exposes the modes supported by its parent. Changing the menu preserves the measured pose, creates one undo entry, and does not require a separate Sizing section.

### AT-CAN-003: Content types

Verify editable text, images, SVG vectors, borders, radius, shadows, opacity, filters, assets, and supported effects. Unsupported rich text and dynamic styling must show explicit limitations.

### AT-CAN-004: Zoom and history

Verify pan, zoom, actual size, fit all, fit selection, command search, undo, and redo on Windows and macOS keymaps. Use menus to prove keyboard-only alternatives exist.

### AT-CAN-005: Pointer and keyboard input

Verify mouse, touchpad, pointer capture, and keyboard-only manipulation. Dragging must not trap focus or prevent cancellation.

### AT-CAN-006: Live resize modifiers

The rendered node, not only its outline, follows every resize pointer frame. Shift preserves the starting aspect ratio for corner and side handles. Alt resizes around the center. Ctrl on Windows and Command on macOS changes the bounds while keeping image pixels and direct freeform children fixed in world space. A rotated node resizes in its local axes while the opposite visible handle remains fixed, so 90- and 180-degree rotation never inverts the side under the pointer. Modifier combinations compose, pointer cancel restores the pointer-down state, and pointer-up creates one undo entry.

Negative control: a test that advances only HUD geometry while rendered bounds remain unchanged must fail.

### UI-MOBILE-001: Mobile editor sheets

At 390 by 844, the canvas remains the primary surface. Layers and Properties open as mutually exclusive shadcn Base UI bottom sheets, stop at a useful partial height, preserve their real tree and inspector controls, trap focus, lock background scroll, and close by their close control, Escape, or an outside press. Read-only viewers can open Layers but cannot open Properties. Desktop rails and resize handles remain unchanged above the mobile breakpoint.

### UI-MOBILE-002: Selected-node quick actions

Select a node near every viewport edge. A toolbar with no more than four real actions stays attached to the selection, remains inside the viewport, never covers the dimension badge, and exposes Move, Scale, Rotate, and Delete using the editor's existing icons. Each action changes the same production state as its desktop counterpart. No unavailable action is presented as working.

### UI-MOBILE-003: Touch canvas controls

At the mobile breakpoint, the primary tool dock contains four real tools, supports horizontal keyboard navigation, and stays above the device safe area. Resize hit targets meet touch use without changing authored node geometry. Visible selection outlines and corner handles are more prominent on mobile while desktop HUD measurements remain unchanged.

### UI-MOBILE-004: Quick-action drag fade

The selected-node toolbar fades out with the theme's small motion at gesture start, becomes inert while moving or resizing, performs no per-sample toolbar render while the phase is unchanged, and restores at the committed selection position. The mobile header contains no experiment control or gesture status. Desktop does not subscribe its shell to this mobile gesture state. Reduced motion removes the fade transition without changing visibility states.

## Auth and authorization

### AT-FILE-ACCESS-001: File routes wait for project access

Open a hosted file URL before the session check finishes, then remove and restore the authenticated project adapter between route readiness and the first file request. The route stays in its loading or sign-in state and resumes with the requested file after access returns. It never renders the internal project-access error.

Negative control: throw an unrelated file-open error after access is ready. The route must report that failure with its error reference instead of retrying it as a reconnect.

### AT-AUTH-001: Better Auth desktop round trip

1. Start a configured desktop without a session. Confirm the full-screen sign-in boundary renders before project services can issue repository commands and the narrow preload API is the only renderer auth surface.
2. Request sign-in and confirm the Electron main process opens the system browser on `/sign-in` with the fixed desktop client id, one state value, and one PKCE challenge.
3. Confirm the hosted screen accepts only the exact desktop request. A signed-out browser offers GitHub. An existing browser session transfers that user without starting another provider sign-in.
4. Complete auth and return through the registered `com.comp-canvas.desktop` application link. Confirm the main process accepts the exact authority-form callback emitted by Better Auth, validates the pending owner and lifetime, and exchanges the one-time result.
5. Confirm the desktop shows a full-screen finishing state during exchange, then opens the editor only after a user is returned.
6. Confirm the renderer receives only required session display data, with no token, cookie, auth client, database URL, or provider secret.
7. Inspect the configured storage behavior and document its protection properties; do not assume encryption.
8. Restart the renderer and verify the main-held session remains usable. Close and reopen the desktop shell while the root development stack is running and verify the hosted auth API remains reachable.

Negative controls: duplicate hosted parameters, raw provider error text, callback replay, altered state, invalid base64url, an unregistered scheme, a wrong callback path, and delivery to an unexpected window. Each must fail. A malformed callback must leave the desktop in a recoverable fixed-copy error state instead of a permanent loader. Inspect the production browser bundle and fail if it contains PostgreSQL, Better Auth server code, database URLs, or secret names.

### AT-AUTH-002: Object authorization

Call project, repository, share, and sync APIs directly as Owner, Editor, Reviewer, Viewer, unrelated authenticated user, and signed-out user. Verify the permission matrix server-side.

Negative control: bypass the UI guard and call the API. Unauthorized access must still fail.

### AT-AUTH-003: Revocation

Revoke a member and a share link. Verify later HTTP requests and active subscriptions lose access. Confirm revoked state is shown without leaking project content.

Expire a collaboration transport ticket without changing database authorization. Verify an active owner re-admits automatically, keeps the visible document, and never enters the access-removed state. Preserve the owner's pending semantic operation across re-admission. As a negative control, change the database access epoch or remove access and verify the same room still terminates the subscription as revoked.

### AT-GHAPP-001: GitHub App installation grants

Connect a GitHub App installation with a valid single-use state and a GitHub user who can see that installation. Live-check the selected repository through GitHub before storing the grant. Verify invalid state, a spoofed setup `installation_id`, another user's installation, an invalid webhook signature, and a duplicate delivery all fail. Installation suspension, deletion, and repository removal invalidate later scans and writes.

Targeted mutation: trust the callback `installation_id` without the live installation and repository intersection check. The suite must fail.

### AT-REPO-LINK-001: Project repository authorization

Call repository-link, scan, pull, patch preparation, and write APIs directly as Owner, Editor, Reviewer, Viewer, an unrelated signed-in user, and a signed-out user. Verify project membership, tenant installation grant, stable repository ID, repository selection, link status, grant generation, and current GitHub access at enqueue, job start, and immediately before a write. A cross-tenant installation, repository from another installation, removed membership, and suspended installation must fail without revealing repository metadata.

Targeted mutations: independently remove the project-member predicate and the installation-repository predicate. Each weakened build must fail the suite.

## Electron and isolation

### AT-SEC-001: Window security configuration

Inspect the created window and assert context isolation and sandbox are enabled, Node integration is disabled, CSP is restrictive, and unexpected navigation, popups, and permissions are denied.

### AT-SEC-002: IPC validation

Exercise every preload method with an invalid sender, malformed payload, oversized payload, missing grant, path traversal, and symlink escape. Confirm denial and safe diagnostics.

Targeted mutation: remove sender validation from one handler. The suite must fail.

### AT-SEC-003: Preview isolation

From user code, attempt to access Node.js, Electron, preload APIs, filesystem, auth cookies or tokens, parent DOM, and privileged IPC. All attempts fail. Confirm allowed preview messaging still works.

### AT-SEC-004: Repository script trust

Import a fixture with install and configuration scripts that attempt network access, secret reads, and writes outside the project. Indexing must not execute them. Approved execution must show scope and run without inherited secrets.

## Authored-code architecture

### AT-CODE-001: Page composition lint

Run AST fixtures covering raw DOM, `className`, Tailwind literals, inline user-facing copy, and feature logic in pages. Each invalid fixture fails. Valid named component composition passes.

Include narrow valid fixtures for required TanStack route declarations, metadata, document shells, and error boundaries. Prove that the exception rejects extra unrelated raw DOM.

### AT-CODE-002: Effect prohibition

Fail fixtures for direct `useEffect`, alias imports, namespace calls, re-exports, wrapper hooks, `useLayoutEffect`, `useInsertionEffect`, class lifecycles, and render-time side effects. Include copied shadcn and generated first-party paths. Exclude only published third-party internals.

Valid fixtures cover pure derivation, event commands, route loaders, owned services, and genuine `useSyncExternalStore` with stable snapshots and cleanup.

Negative control: disable alias resolution. The alias fixture must demonstrate that the suite detects the weakened rule.

### AT-CODE-003: Runtime boundaries

Attempt server package imports from desktop renderer and browser packages from server-only modules. The build or lint must fail. Confirm atomic level alone does not grant access.

### AT-CODE-004: Imported source exemption

Open an imported fixture that violates first-party architecture rules. Connection and preview must not rewrite it. An explicit approved transform is tested separately and requires a diff.

## Sharing

### AT-SHARE-001: Local upload consent

Start Share on a local-only project. Confirm the UI lists every repository file, generated preview asset, and metadata category proposed for upload. Cancel and verify no upload occurred. Approve a subset and verify only that subset reaches the server.

### AT-SHARE-002: Roles and links

Verify Owner, Editor, Reviewer, and Viewer behavior. Verify active, expired, revoked, and disabled links through direct API access and the UI.

### AT-SHARE-003: Authenticated view links

As the owner, switch a cloud file between `Only you` and `Anyone with the link`. Opening Share must not change access. Copying the link must preserve the current file, page, and node URL without changing access. A signed-in non-owner can load the stored document and join live sync as `viewer` only while link viewing is enabled. The viewer receives checkpoints and ordered updates but no owner, project, repository, presence-write, document-write, or share-mutation capability. Signed-out access returns `401`. Private and nonexistent files return the same `404` response.

Negative controls: lose the response after the server commits an access change and confirm the UI re-reads the server state instead of claiming rollback. Make the reconciliation read fail and confirm the UI shows an unconfirmed state with a retry action. Revoke access and verify the next HTTP request and existing viewer room capability fail. Replace the viewer role with an editor role in the test fixture and verify the mutation boundary catches the escalation. This slice does not satisfy `AT-SHARE-002` until roles, expiring links, rotated revocation, and disabled-link states exist.

## Hosted files and live sync

### DEV-STACK-001: Complete local service startup

Run `pnpm test:service-topology`, then `pnpm test:dev-stack` against Docker Postgres. Verify the editor, preview, login, API, sync Worker and DO emulator, Container-compatible room runtime, Assets Worker, thumbnail renderer, and thumbnail jobs bind distinct loopback ports, satisfy their explicit readiness status, share generated service credentials without exposing them to Vite, and terminate their full process trees after the check. Exercise one real room join, semantic operation, acknowledgement, reconnect, and idempotent replay before reporting ready.

Run `pnpm verify:local` for the release-oriented local gate. It must include the non-Docker repository checks, real PostgreSQL control-plane and sync transaction suites, and the nine-service startup and shutdown smoke test.

### DEPLOY-VERCEL-001: One Vercel project per hosted HTTP surface

Run `pnpm test:vercel-config`, `pnpm test:vercel-builds`, then `pnpm vercel:check`. Verify the editor, login, API, and thumbnail renderer each have one unique project, root directory, build command, output or function contract, environment-name allowlist, and checked-in `vercel.json`. Derive the API's directly required environment names from its TypeScript runtime and fail if the deployment contract omits one. Execute every declared build from its configured project root, require the thumbnail renderer to generate and verify its registry before Vite starts, and require the API contract to carry the matching registry fingerprint. Exercise the API rewrite adapter with body and query preservation. Confirm setup creates and Git-links projects without deploying, keeps `main` as the production branch, enables Git deployments only after explicit setup approval, and assigns each stable staging domain to the persistent `staging` branch. Keep R2 and revision sync on Cloudflare, and keep browser capture private until its stateful contract has a verified platform adapter.

### DEPLOY-STAGING-001: Persistent staging promotion

Run `pnpm test:deployment-config` and `pnpm test:vercel-env`. Verify production and staging have disjoint origins for editor, login, API, preview, thumbnail rendering, assets, and sync. The preview iframe must remain cross-origin. Validate `.env.staging` without printing its values, then upload each Vercel variable only to the Preview environment scoped to the `staging` branch. Push a test commit to `staging`; wait until the web and API deployment endpoints report that exact revision, deploy assets, the private thumbnail queue, the sync coordinator, and the sync Worker with scoped Cloudflare credentials, then probe the live WebSocket protocol before exactly one open pull request targets `main`. Push another test commit and confirm the existing pull request updates instead of creating a duplicate. Merge that pull request and confirm only the `main` revision reaches production.

Negative controls: point any staging service at its production origin, reuse the production auth cookie prefix, scope the staging cookie so it cannot reach the sync host, omit a required staging secret, add a direct workflow push to `main`, or remove the existing-pull-request check. Each mutation must fail its staging configuration test.

### CLOUDFLARE-R2-001: Private environment-isolated object storage

Run `pnpm test:cloudflare-config`, then `pnpm cloudflare:check`. Verify Wrangler is authenticated to the manifest account, local development uses simulated R2, preview points only to the private development bucket, and production names a distinct bucket. The remote bucket must have `r2.dev` disabled, no bucket-level custom domains, the exact managed marker lifecycle rules, and the environment's declared Worker deployment state. Setup may create or reconcile the selected bucket and lifecycle configuration, but it must not upload an object. Once the Worker is deployed, the check permits stored objects because they are staging user data. Authentication failures, an unexpected account, ambiguous inspection errors, public access, missing deployed Workers, remote local bindings, or preview and production bucket collisions fail closed.

### CLOUD-FILES-001: Canonical hosted file persistence

Create, list, open, and save a blank file through the hosted API against PostgreSQL. Verify the file summary and canonical document stay separate, revisions advance by compare-and-swap, and invalid identity, geometry, extra fields, stale revisions, signed-out access, and another account all fail without leaking file existence.

### FILE-ASSET-001: Private file assets

Create a scoped upload intent, upload a checked image to the private R2 binding, read it through the authorized file route, copy it without exposing a bucket credential, and write and read the stable file thumbnail. Verify create-only writes are atomic. Reject cross-file access, an untrusted mutation origin, extra fields, size mismatches, unsupported media, mismatched magic bytes, and malformed service authorization.

### FILE-ASSET-SEC-001: Asset authorization boundary

Keep the R2 bucket private. Require either one authenticated user credential plus the Worker service secret, or the dedicated thumbnail-service credential on thumbnail-only routes. Canonicalize every object key and recheck file ownership or the exact capture revision before each read or mutation. Reject credential-bearing redirects, non-loopback HTTP service origins, traversal, replayed intents, malformed authority responses, corrupt or oversized images, and unmetered malformed upload attempts without creating an exposed object.

### FILE-ASSET-LIFECYCLE-001: Durable image attachment and hydration

Normalize an imported image, upload it through the private file-asset service, and accept only the canonical MIME, extension, byte length, dimensions, and SHA-256 derived from the service's decoded bytes. Put the verified bytes into the editor sidecar before submitting `asset.attach`. A failed or unverified upload creates no document reference. A successful upload followed by a rejected semantic command may leave only an unreferenced immutable object for later garbage collection. After reload and in a second authorized collaborator, fetch the referenced object with credentials and redirects disabled, bound the response before buffering, verify its MIME, length, and digest, then publish one hydrated document that renders the image. Keep image bytes out of WebSocket operations, PostgreSQL projections, checkpoints, and undo history.

Negative controls: forge client dimensions or digest, lose the upload response after an exact immutable write, return a missing or mismatched object during reconciliation, switch file or generation while hydration is in flight, attempt upload as a viewer, and serve an object for another file. Exact lost-response reconciliation succeeds without a duplicate attachment; every mismatch fails visibly with the sanitized request reference and never enters the preview sidecar.

### AT-THUMB-001: Revision-bound thumbnails

Load the dedicated `/thumbnail-renderer` surface with an injected, revision-bound source. Verify it hides editor chrome, fits the content, settles for three animation frames, and publishes the Paper readiness markers before headless capture. Wake one private Playwright queue container from the scheduled Worker with only the staging service origins and dedicated secrets, and keep its public Worker route closed. Decode the captured AVIF, upload it to an immutable revision-and-nonce key, and commit its exact key and ETag through the file metadata compare-and-swap. Serve only that committed generation through `/file-assets/thumbnails/:fileId/thumbnail.avif`. A stale revision, failed capture, corrupt output, failed upload, failed metadata commit, replay, uploaded-but-uncommitted object, missing secret, or non-HTTPS hosted origin must not replace or expose the current thumbnail.

### CLOUD-SYNC-CLIENT-001: Browser revision sync

Open the same hosted file in two browser clients. Verify the editor passes the exact committed command or batch to persistence without reconstructing a document diff. Undo must submit the command's semantic inverse and redo must resubmit its canonical forward command through the same WebSocket path. Verify one typed semantic operation is persisted before acknowledgement, receives one canonical sequence, and updates the other canvas immediately. Commit another command while the first acknowledgement is in flight and verify the client retains both commands in original order until their matching acknowledgements. Lose an acknowledgement and verify replaying the same mutation id returns the committed result without applying twice. Stream catch-up into staging and publish one validated snapshot only after every expected chunk verifies. Remove the generic JSON-diff and HTTP document-write paths from the live editor so WebSocket and HTTP cannot become competing authorities.

Negative control: corrupt one chunk in a multi-chunk catch-up and verify the visible document, acknowledged sequence, and durable local queue remain unchanged.

### COMPONENT-BINDING-SAVE-001: Hosted component placement

Place each component from the fixed browser catalog into a blank hosted file and save it through the live semantic-operation path. The browser projector and authoritative room must validate against the same trusted catalog, preserve the exact component id and export name, and acknowledge the resulting revision without an HTTP document write.

Negative control: submit an unknown component id, a known id with a forged export, or an unsupported prop. Each must fail with `Component binding needs review` or the specific prop validation error without changing the room projection.

### CLOUD-SYNC-CONFLICT-001: Remote conflict preservation

Make a local unacknowledged operation, then receive a remote operation. Verify reconciliation preserves the local operation and applies both in canonical server order when their semantic preconditions remain valid. Reject an operation whose target, component identity, role, or precondition no longer permits it, keep the rejected operation available for recovery, and show one named failure. Reuse a mutation id with different contents and verify rejection.

Negative control: remove the semantic precondition check and verify the test detects a stale operation overwriting a newer incompatible change.

### CLOUD-SYNC-PG-001: PostgreSQL sync transaction

Against real PostgreSQL, verify the append-only semantic operation log, exact replay idempotency, validated document projection, active generation, monotonic fencing token, immutable checkpoint pointer, and owner or viewer access epoch. An acknowledgement follows the committed append. Checkpoint pruning removes only operations covered by the verified committed pointer. A repository restart rebuilds the same validated document from checkpoint plus remaining operations. The production service fails closed without its database binding and never uses the in-memory repository.

Negative controls: inject a failure between operation append and projection update and verify byte-for-byte transaction rollback. Move the acknowledgement before commit and kill the room; the replay test must detect the lost operation.

### CLOUD-SYNC-AUTH-001: Hosted sync authorization

Verify the browser joins through the Worker with the Better Auth session shared across the configured HTTPS API, app, login, and WSS sync subdomains. The Worker issues a short-lived room capability bound to the exact subject, file, role, generation, protocol epoch, access epoch, and expiry. The Container verifies that capability, current role, access epoch, generation, and fence before every update. Loopback development must not set a parent-domain cookie. Reject a cookie domain outside the Better Auth host, unsigned requests, another account, expired capabilities, role escalation, and revoked sessions.

Negative control: bypass the per-update capability check in the test adapter and verify another file, viewer, or stale generation can mutate, causing the suite to fail.

### CLOUD-SYNC-DO-001: Durable Object room coordination

Run the sync Worker tests and dry-run build. Verify the Worker resolves the active generation and routes to a server-created `sync:<protocolEpoch>:<fileId>:<generationId>` Durable Object. The generation DO owns only admission, bounded Container startup, health, proxy, drain, and stop. PostgreSQL remains the cross-generation lease and data authority. Separate files and generations never exchange frames, the client cannot select a generation, and an inactive file can receive a new generation without migrating document data through the DO.

Negative control: restore a permanent `sync:<protocolEpoch>:<fileId>` identity and verify the relocation acceptance fixture rejects it.

### CLOUD-SYNC-DO-SEC-001: Durable Object authorization boundary

Reject non-WebSocket requests on the sync route, an untrusted or missing origin, malformed file or tab identifiers, binary and oversized frames, cross-file subscriptions, another account, a revoked session, a client-selected generation, and malformed authorization responses. Keep credentials out of URLs and client frames. Give the generation DO no document mutation API and no repository or source credential. Fail closed when the API, room runtime, database path, or signing credential is unavailable.

Negative control: expose a document or arbitrary fetch method through the control-plane test adapter and verify the boundary test fails.

### CLOUD-SYNC-STATE-001: Client collaboration state machine

Drive the client through `cold`, `opening`, `authorizing`, `hydrating-local`, `admission-queued`, `streaming`, `applying`, `live`, `read-only`, `offline-clean`, `offline-dirty`, `reconnecting`, `replaying`, `access-revoked`, `incompatible-build`, `capacity-refused`, `connection-failed`, `draining`, `parked`, `closing`, and `closed`. Verify only documented transitions occur, streamed state publishes atomically, terminal states do not reconnect, and visible copy stays limited to `Opening file…`, `Connecting…`, `Offline`, `Reconnecting…`, `Saving changes…`, `Read only`, `Access removed`, `Update required`, `File is busy`, and `Connection failed`.

Negative control: force an undocumented transition from `access-revoked` to `replaying` and verify no operation reaches the transport.

### CLOUD-SYNC-CACHE-001: Account-scoped local cache

Persist the last validated checkpoint, sequence, and pending semantic operations in IndexedDB under account, file, document schema, and protocol epoch. Bind every checkpoint to the server-derived replay-scope digest for its verified subject, file, role, and access epoch. Stage cached document bytes invisibly until `room.assigned` confirms the exact replay scope. A matching assignment may publish the checkpoint; a mismatch must atomically clear the durable checkpoint, clear any in-memory checkpoint from the earlier scope, quarantine mismatched pending work, and only then decide whether a resume frame is needed. Verify an authorized session can hydrate it, a corrupt entry falls back to the server without changing the visible document, and sign-out, account change, role change, revocation, schema change, and protocol change prevent disclosure. Desktop cache credentials remain in Electron main and never cross preload.

Negative controls: remove the account segment from the cache key and verify the cross-account fixture detects private content. Replace one cached checkpoint byte and verify validation rejects it. Seed a legacy checkpoint without a replay scope and verify it is repaired away without ever publishing. Seed a valid checkpoint under one scope, reopen under a different server-assigned scope, and verify neither startup nor reconnect exposes its document before the durable record is cleared.

### CLOUD-SYNC-REPLAY-001: Durable offline replay

Persist each local operation before transmission together with the server-derived replay-scope digest for its verified subject, file, role, and access epoch. Disconnect with multiple queued operations, reload the page, reconnect through authorization and admission, apply remote catch-up, and replay the original mutation ids in order only after the new room assignment confirms the same replay scope. Verify acknowledged operations leave the queue, a lost acknowledgement remains idempotent, revoked or changed access preserves unsent work for explicit recovery without transmitting it, and legacy unscoped rows are quarantined before resume.

Negative controls: delete a queued operation before its acknowledgement and terminate the client; the reopened fixture must detect the missing edit. Pause durable enqueue after it selects `pending` but before transaction commit, revoke access, destroy the original client, let the stale transaction commit, and verify a separately created client quarantines the row when the server assigns a different replay scope without sending the operation.

### CLOUD-SYNC-CONTAINER-001: Regional authoritative room

Run the approved Cloudflare platform fixture. Verify the first opener of a cold file creates one generation and starts one Container, concurrent openers converge on that generation, all live document and presence traffic uses that Container, and the room stays pinned while active. After drain and lease release, open from the relocation fixture and verify a new generation can be created through that request path. Record observed DO region, Container region, startup time, and socket latency without claiming colocation.

Staging deployment evidence must also show that the runtime Worker has no public route, each file generation resolves to a stable Container object name, the admission Worker exposes only `sync-staging.canvas.ripgrim.com`, and the public, coordinator, and runtime secrets remain split across their owning services.

Negative controls: start two authoritative Containers for the same fence and verify one loses acquisition. Reuse the prior generation after release and verify it cannot acknowledge an operation.

### CLOUD-SYNC-LEASE-001: Generation lease and stale-owner fencing

Against real PostgreSQL, race two generation candidates, renew the winner, let it expire, and acquire a higher monotonic fencing token. Require the current fence on every operation append and checkpoint-pointer update. Verify release is idempotent and a crashed owner cannot renew or write after replacement.

Negative control: remove the fence predicate from one append statement and verify a stale owner can corrupt ordering, causing the test to fail.

### CLOUD-SYNC-CHECKPOINT-001: Immutable checkpoint recovery

Create a checkpoint from a known operation sequence, upload it under an immutable R2 key, verify its digest, atomically advance the PostgreSQL pointer, and replay later operations into the same validated document. Verify missing, corrupt, partially uploaded, and uploaded-but-uncommitted objects never replace the current checkpoint. Prune only log entries covered by the committed pointer.

Negative controls: point PostgreSQL at an object before digest verification and verify recovery fails. Mutate one covered operation before compaction and verify the reconstructed document no longer matches the independent expected bytes.

### CLOUD-SYNC-DRAIN-001: Drain and crash recovery

Send the active room a drain request and `SIGTERM`. Verify it stops admission, tells clients to reconnect, rejects new operations, finishes committed writes, checkpoints when the shutdown budget permits, releases the lease, and exits. Force termination without a drain and verify a new generation restores the last acknowledged state and accepts idempotent replay of unacknowledged client operations.

Negative control: make shutdown acknowledgement depend on the final checkpoint and kill the process before it completes; the test must prove whether acknowledged work was lost.

### CLOUD-SYNC-MEMORY-001: Large-document memory budget

Measure Container peak resident memory while loading, validating, editing, replaying, checkpointing, and draining both the current maximum fixture and an independently generated 50 MB document fixture. Keep media bytes in R2 references. Fail when decompression, cloning, undo, indexes, WebSocket buffers, or compaction exceed the selected Container class and safety margin. Record the selected instance class and measured peaks instead of estimating them.

Negative control: switch the hot edit path back to full-document clone and verify the peak-memory budget fails.

### CLOUD-SYNC-SCHEMA-001: Semantic operation validation

Validate every operation against its exact schema, role, target identity, component binding, relationship invariant, document schema, protocol epoch, generation, and configured size limits before mutation. A rejected operation changes neither live state, durable log, projection, checkpoint, nor other clients. Run migrations once under the active fence during cold hydration; incompatible clients receive `Update required`.

Negative control: disable one relationship or component-identity validator and verify the mutation fixture creates an invalid projection, causing the test to fail.

### CLOUD-SYNC-YJS-001: Conditional Yjs authority

Run this acceptance only if the approved platform and protocol decision adopts Yjs. Verify one binary Yjs authority, server-validated semantic command input, state-vector catch-up, binary checkpoint persistence, local-origin undo, and a validated `FileDocument` projection. Media stays outside the Y.Doc. No revisioned JSON or HTTP path may remain writable in parallel.

Negative control: persist a Yjs document through JSON and reapply it; the fixture must detect duplication or divergence. Keep this ID not applicable, not passing, while Yjs remains unadopted.

### CLOUD-SYNC-READONLY-001: Live viewer enforcement

Give a signed-in non-owner an active link-view grant. Verify the viewer receives the current checkpoint and ordered live updates through a capability bound to `viewer`, but cannot send document operations, presence writes, share changes, repository actions, or source writes. Revoke the grant and verify the current connection closes or downgrades before another update and cannot reconnect. Private and nonexistent files remain indistinguishable.

Negative control: issue the viewer capability with an editor role in the fixture and verify the server-side authorization test catches the escalation before document mutation.

### CLOUD-SYNC-PRESENCE-001: Ephemeral room presence

Open the same file and generation with two authenticated sockets. Verify each receives one authoritative roster, one join event, monotonic page, focus, selection, camera, cursor, and interaction updates, and one leave event. On the first multiplayer transition, publish the complete local awareness state once. Suppress routine awareness traffic in single-player mode. Cap cursor and camera publication at roughly 33 Hz without allowing immediate interaction traffic to flush them early. Send every active interaction sample immediately over the socket. A page change clears prior page-scoped selection, camera, cursor, and interaction state, including an explicit transition to no page. Presence must not enter PostgreSQL operations, the document projection, checkpoints, undo history, or source review. Presence authorization uses the admitted capability until the next lease revalidation; durable document operations still recheck current access before every write. A signed-in viewer receives presence but sends no awareness frames.

Negative controls: send a stale sequence, cross-file update, cross-generation update, malformed field, oversized payload, and viewer update. Each must fail without changing another participant's presence. Remove the file or generation comparison and verify the cross-room fixture fails.

### CLOUD-SYNC-GESTURE-001: Authoritative interaction ownership

Start overlapping gestures from two authenticated editors. The room grants the first accepted interaction ownership of its page and node ids, echoes the acquisition and release to the sender, broadcasts every accepted transform sample to collaborators, and does not echo steady transform samples back to the owner. Every immediate interaction frame includes its page id, including single-player rooms where routine awareness is intentionally suppressed. It discards a competing acquisition and refuses a losing semantic command that touches the locked node, an ancestor of it, its containing structural parent, or its page before persistence. A client may preview optimistically, but cannot create the semantic commit until the room echo confirms ownership. If pointer-up precedes that echo, retain the exact rendered preview until ownership resolves, then commit that same geometry or discard it on denial. Keep the exact interaction lease until that gesture's semantic save is acknowledged or fails; an immediate compatible gesture from the same client reuses that confirmed lease so it can begin without waiting for the prior save, while the lease remains held until every local claim settles. An older queued save settling first must not release it, and a delayed completion must never release a newer room's interaction. A mutation waiting to commit reserves its affected scope so another client or an incompatible local gesture cannot lock the same node underneath it. The owner cannot change its interaction id, kind, page, or node set until it releases the interaction. Disjoint nodes remain independently editable. Pointer cancel, failed publication, failed persistence, disconnect, room switch, and disposal release ownership. A failed release frame uses a browser-valid application close code and tears down the transport so disconnect clears authoritative room ownership; reconnect full-state publication cannot replay the stale interaction. After all acknowledged pointer-up saves release the lease, another editor can acquire the same node. The client yields to any overlapping remote interaction reported by the authoritative roster; participant-id ordering never decides ownership.

Negative controls: race two acquisitions for the same node, mutate the winning lock's node set, claim a missing or cross-page node, submit a nested batch that changes a locked descendant through its ancestor, insert or reparent into its locked container, delete its page, attempt acquisition while an overlapping append is blocked, fail immediate acquisition publication, fail a release frame after acquisition, fail an older queued save before the gesture's own save, fail semantic persistence, deny ownership before pointer up, settle an old room's save after a new room acquires a lease, attempt an incompatible local gesture before the first lease releases, release one of two compatible local claims, disconnect the winner, and edit a disjoint node. Assert exactly one room-confirmed owner, no phantom republished lock, no losing append or local semantic commit, no early release while a local claim remains, release on failure or disconnect, and no false conflict for the disjoint edit.

### UI-COLLAB-PRESENCE-001: Collaboration identities and cursors

Render the identity strip at the left of the right property-panel header, with the panel actions pushed to the far edge. It must leave with the panels while following; the read-only shell may use the documented canvas fallback because it has no right panel. Render the local identity first, then deduplicated active agents, then remote people in roster insertion order. Exclude explicit headless sessions. Show up to two agents and four remote people before overflow, but collapse only when at least two identities are hidden, so exactly one extra identity stays visible. Human avatars use 22 px circles, 4 px overlap, and a 2 px panel-surface outline; agent marks use 14 px inside the same footprint. Verify account-image and uppercase-initial fallbacks, themed hover and focus tooltips with `<name> (you)` for the local identity and the remote name for remote identities, no separate viewer icon, a count-only overflow trigger that opens an identity roster, one accessible name per roster row, hidden-agent-first ordering, deterministic background and foreground color pairs, and keyboard access. Remote cursors use Paper's centered, outline-free 8 px dot and adjacent name pill, render only on the active page, and append a 16 px eye-off icon in the name pill while the participant is blurred. Verify 2 px same-page selection filtering, 80% cursor opacity and 25% selection alpha while blurred, per-axis 1,000 px cursor snap behavior, final-position convergence after the last network sample, and reduced-motion behavior. Joining and leaving update the roster without a toast.

Negative controls: remove the active-page guard and verify an off-page cursor fixture becomes visible. Move a cursor by 800 px on both axes and verify it interpolates rather than snapping. Stop network samples after one ordinary move and verify the displayed cursor still reaches the authoritative final coordinate.

### UI-COLLAB-FOLLOW-001: Follow collaborator camera

Activate a remote avatar and verify the editor enters `following {name}`, follows that person's page and camera, hides both panels without unmounting their owned state, and shows the stable collaborator-colored 10 px solid boundary plus `stop following`. Stop and restore the exact prior panel visibility and owned state on local pan or zoom, explicit stop, participant departure, generation replacement, room switch, and disposal. A same-value local pan or zoom command still stops following.

Negative controls: retain the followed participant across generation replacement and verify the stale-participant fixture fails. Start with one panel hidden, follow and stop, and verify that panel remains hidden rather than being reset to a default layout.

### UI-COLLAB-READONLY-001: Viewer editor shell

Open a shared file as a signed-in viewer. Render the regular editor shell while hiding the right inspector, repository, source, share, and mutation controls. Assert that the editor layout reserves no right-inspector column. Keep viewer authority stable while the room connects, reconnects, or reports a transient error. Show one compact bottom-centered dismissible notice with the existing 18 px eye icon, close icon, and exact copy `You can only view this file` and `To edit, ask the owner to add you as an editor`. At narrow widths the notice clears the floating mobile toolbar and reserves enough canvas space that neither control covers the other. Navigation and explicitly approved view interactions remain available. Direct mutation attempts still fail at the store and server boundaries.

Negative control: expose one source or document mutation command in the viewer capability fixture and verify the test fails even if the visible control is hidden.

### UI-COLLAB-ANON-001: Signed-out public viewer

Open an anyone-with-the-link file while signed out. Render the same full read-only editor shell, including pages, layers, pan, zoom, selection, stored image assets, collaboration identities, and the single bottom read-only notice. Represent the signed-out participant as `Guest` with the generic user mark. Public document and asset reads must require an active view share, while document writes, asset writes, presence writes, share changes, source actions, and repository actions remain denied. Signing out of a private file clears its rendered document before the route is reloaded. Revoking the share invalidates admission, public asset reads, and idle room subscriptions on the next lease revalidation.

Negative controls: request the same private and nonexistent file while signed out and verify both are indistinguishable. Attempt to inject an owner role or mutate through the document store, asset service, or room protocol and verify every boundary rejects it.

### CLOUD-SYNC-LIFECYCLE-001: Sync disposal

Verify retry delays are bounded and repeated pre-upgrade close, socket-construction, and room-open-send failures stop in an honest connection-failed state. Capacity retries stop. Terminal authorization and compatibility failures before or after assignment do not reconnect. Authority-neutral connection and capacity failures leave durable edits pending for automatic replay. File switches close the prior room, sign-out stops sync, and page, HMR, failed cache hydration, and workspace disposal remove sockets, timers, lifecycle listeners, IndexedDB subscriptions, awareness, and owned services.

Negative controls: retain one reconnect timer after disposal and verify the resource-budget assertion fails. Deliver a terminal room error after sync readiness and verify a stopped client cannot remain visibly live.

### CLOUD-SYNC-LIFECYCLE-002: Hibernating connection liveness

Verify transport pings begin only after sync readiness and receive the platform response where supported, a missing pong closes the stale socket, reconnect continues with capped jitter, stale socket callbacks cannot mutate the current generation, and clients that start or become offline or hidden do not spin a reconnect loop. Park a hidden idle client only after its local queue is durable. Returning online or visible resumes through authorization and admission from the last acknowledged sequence. If access is revoked while a mutation is still entering durable storage, resolve its status inside the durable enqueue transaction and atomically clear the revoked checkpoint and classify all queued mutations where the process remains alive. If teardown happens between the status choice and transaction commit, the separately persisted server replay scope must still prevent that row from replaying under the changed access grant and reclassify it as explicitly recoverable before room resume.

Negative controls: let a callback from the prior generation publish after reconnect and verify generation isolation fails the test. Start the client offline and verify it never remains stranded in authorizing. Delay initial snapshot delivery past one heartbeat interval and verify the client does not kill the healthy admission.

### OBS-SYNC-001: Collaboration telemetry and visible failures

Carry one request reference through Worker admission, generation DO startup, Container handling, PostgreSQL append, client state, toast, and operational log. Record phase, error code, protocol epoch, app platform, app version, generation, and fence without logging document content, operation payloads, cookies, capabilities, credentials, or source patches. Emit named load, replay, checkpoint, drain, and lease-loss phases without invented percentages. Deduplicate reconnect errors into one visible episode and keep blocking recovery actions available after the toast closes.

Negative controls: discard the reference at one boundary and verify correlation fails. Inject a document payload and room ticket into the logger fixture and verify redaction fails the test.

## Copy and accessibility

### AT-UX-001: Action naming

Audit menus, shortcuts, command search, dialogs, and toasts. One action uses one label. Copy is sentence case, has no em dashes, and gives a recovery action for known failures.

### AT-UX-002: Accessible operation

Complete project opening, component insertion, selection, prop editing, review, Save, conflict resolution, and promotion using keyboard and a screen reader. Check focus order, names, roles, live regions, contrast, zoom, and reduced motion.

### AT-COLOR-001: Color picker rail fidelity

Open the same known color through Fill, Outline, Border, and Selection colors. Verify the hue thumb sits over the matching spectrum color, the saturation and brightness plane uses that hue, and pointer and keyboard edits agree. Verify opacity remains reversed with 100% at the top. The eyedropper and close actions stay side by side, value labels remain on one line at the supported compact width, Escape restores the prior color, and one completed gesture creates one document command.

### AT-UX-003: Shell, loading, and recovery states

Use observable engine events to verify the four-region shell, project opening, and preview lifecycle. Confirm startup and file opening use indeterminate progress unless measured totals exist, preserve the prior file until new metadata resolves, and display only phases whose work actually started. Trigger load failure, offline state, preview stop, crash, and invalid source. Confirm each known failure has one primary recovery action, invalid source retains the last good preview with current diagnostics, and closing the preview disposes owned resources.

Visual review fixture: compare shell geometry and hierarchy against the supplied authorized Wonder/Paper reference evidence, including file bar, left rail, canvas/tool strip/zoom controls, and right inspector. Match only verified details; record unknown startup, autosave, conflict, and GitHub writeback behaviors as unknown rather than asserting parity. This is a design review criterion and must include screenshots plus the tested viewport and platform.

Web and desktop start on the same Recents home. An account with no files shows the empty home without opening or offering a fixture. Repository controls are absent in the browser editor and remain available only in the desktop editor.

At 1500 by 922, verify Recents uses the fixed left rail, a persistent New file action, grid and list controls, Paper-shaped 256:168 grid thumbnails, 96-pixel list thumbnails, relative edit dates, and search with an independent no-results state. Creating a file must persist the default Page 1 document and navigate to its permanent file URL. Evidence: `apps/web/tests/home-screen.mjs` and `outputs/home-screen/`.

Run `pnpm test:home-auth-parity` without starting the cloud stack. It must launch isolated browser-backed web and login fixtures, capture 1500 by 922 and 480 by 800 states, keep New file and search usable without horizontal clipping, expose the unavailable Google provider reason as visible text, and shut the fixtures down.

### AT-UX-004: Share access behavior

Open Share and verify it changes no permissions. Copy a link and verify it changes no permissions. Change link visibility and verify the consequence is stated before commit, public access requires confirmation, and the hosted service confirms the resulting state. Verify invite failure preserves entered recipients and role. Test local-only sharing consent against the exact listed upload set.

### ERROR-VISIBILITY-001: No hidden operational failures

Force an unexpected API failure and verify the server logs the original error with a request ID while the response exposes only the safe message and that same ID. Verify browser and desktop command failures preserve the ID through their client boundary and render it in the owning recovery state. Run `pnpm lint:contracts` and verify the AST check rejects empty catch clauses and promise rejection handlers that discard the error.

Force a document command failure and verify it appears in the global toast viewport with a specific title and actionable description. The picker accepts image inputs up to 25 MB so supported static inputs can be normalized before attachment. A supported image at the canonical 1,500,003-byte embedded preview limit keeps its bytes; a browser-decodable static input above that limit becomes bounded WebP. An animated GIF or WebP above that limit must be rejected before decode with the exact visible message `This animated image exceeds the 1,500,003-byte embedded preview limit. Choose an AVIF, PNG, JPEG, GIF, or WebP image within that limit.`, never the internal `Invalid image data` validator message. Persistence failures also retain the inline Retry control.

## Application updates

### DESKTOP-UPDATE-001: Recoverable updater state

Run the desktop updater against the mock feed. Verify checking, available, downloading, ready, up-to-date, disabled, and error are distinct cached states observed through narrow IPC. A failed check never reports up to date. A failed download returns to the available state, and a later check failure never discards an already downloaded installer. Concurrent checks, downloads, and installs coalesce into one action. Download progress publishes at most once per five-point bucket and always publishes completion.

Negative controls: return the same boolean for no update and failure and verify the state test fails. Clear a ready installer after a network failure and verify recovery fails.

### DESKTOP-UPDATE-002: Safe install and channel isolation

Verify nightly and stable use different feed manifests and installed application identities. Preview and pull-request artifacts contain no update feed metadata. Nightly versions increase with the workflow run. Before restart, wait until the editor has no active gesture and its document queue is saved; a save failure or ten-second timeout leaves the downloaded installer ready and shows a recoverable error. The main process disposes owned services before calling the installer, while ordinary quits still use the normal disposal path.

Launch the packaged Windows executable after every PR and release build. The Electron main process must import its CommonJS updater dependency, reach `app.whenReady()`, and exit the startup smoke path without a JavaScript error dialog or uncaught exception.

Negative controls: remove the save guard and verify a dirty-document fixture blocks the gate. Add update metadata to a preview artifact and verify the release-policy test fails.

### UPDATE-FEED-001: Signed immutable release feed

Build a release from the exact authorized merged commit. A complete signing identity produces an automatic update release and must fail closed without its Cloudflare update bucket or channel-scoped credentials. With no signing values configured, publish an unsigned manual-download installer with no updater metadata and do not touch R2; a partial signing identity must fail. For signed updates, publish the GitHub release first, upload versioned installer and blockmap objects second, and replace the small channel manifest last. The public update Worker is read-only, sends mutable manifests with `no-store`, immutable artifacts with a one-year cache policy, and supports correct single byte ranges for differential downloads. The updater must enforce manifest SHA-512 plus the configured Authenticode publisher.

Run the database migration command from a clean checkout with generated package output absent. It must build `@canvas/database` and its workspace dependencies before executing the migration entry point.

Negative controls: attempt an update-feed write, path traversal, arbitrary object read, invalid byte range, unsigned release, and direct branch push. Every case must fail without advancing the channel manifest.

### WEB-UPDATE-001: Browser deployment refresh

Every web build emits a no-store `version.json` with a unique build id. Check after startup, every fifteen minutes, on focus after five minutes, and after a stale dynamic-import failure. A different build id shows one compact refresh notice; the same id stays quiet; a failed request remains an explicit retryable error and is never presented as current.

## Performance

### AT-PERF-001: Interaction budgets

Measure shell startup, selection, drag, inspector update, incremental preview build, and indexing phase response against `PRODUCT-SPEC.md`. Record hardware, release build, fixture size, warm or cold state, sample count, median, and p95.

For inspector scrubbing, use the 1,000-node fixture and record one five-second outline-width scrub in a release build. Capture pointer event time, React commits, preview projection count, scripting time, paint time, and long tasks. The canvas must update during the gesture, the numeric field must show the current value, the editor shell snapshot must stay stable for every preview tick, and preview projection must run at most once per animation frame. Verify drag preview stays within 33 ms p95 and inspector preview within 100 ms p95.

Negative control: restore direct shell subscription to live appearance overrides and verify the profiler detects a shell commit for the scrub ticks and fails the gate. Memoizing only the numeric field must not make that mutation pass.

### AT-PERF-002: No fake progress

Instrument phase events. Verify each visible phase corresponds to a started task and Ready appears only after required tasks finish. Counts must equal measured items.

## Release gate

P0 requires every `AT-P0`, `AT-ID`, `AT-SRC`, `AT-PRV`, `AT-AUTH`, `AT-SEC`, and `AT-CODE` test to pass for the supported Vite adapter. Any skipped critical test blocks the gate. P1 adds canvas breadth, copy, accessibility, sharing, and performance gates. Record adapter limitations and remaining P2 work without presenting it as shipped.

## Local document architecture

### AT-DOC-001: Blank file and lightweight index

Create a file from the home screen. The stored index entry carries id, name, and timestamps only; the file content is a separate record holding one `schemaVersion: 2` document with one page, one structural root node, no relationships, and an empty theme. The canvas shows no visible frame, no demo components, and the preview renders nothing. Evidence: `apps/web/tests/document-architecture.mjs` check 1.

### AT-DOC-002: Identity through edits and reload

Rename, duplicate, undo, delete, restore, and reload a drawn node. File, page, and node ids never change; the duplicate receives a new id and sits one gap to the right; the layer tree, the stored relationships, and the preview DOM agree on parent and order after every step. Evidence: `document-architecture.mjs` check 3, `packages/repo-engine/tests/file-document.test.ts`.

### AT-DOC-003: Parent-local geometry and world pose

Drag a top-level rectangle into a frame. The stored relationship changes to the frame, the stored `styles.left/top` equal world position minus the frame's world position (the Paper sample: world -156,-194 under a parent at -174,-221 becomes 18,27), and the HUD rectangle does not jump. Evidence: `document-architecture.mjs` check 2, `file-document.test.ts` reparent cases.

### AT-DOC-004: File-scoped tokens

Create a token in the Theme tab, bind nodes on two pages, change the value once, delete with inline replacement, and undo. Both pages resolve the same token id; the delete rewrites every solid fill, gradient stop, and alias across the file in one undoable step; undo restores the token and the references. A second file has its own empty theme. Evidence: `document-architecture.mjs` checks 4, 5, 7; `file-document.test.ts` token cases.

### AT-DOC-005: Legacy migration

Seed a version 2 browser collection with two pages that define the same token name with different values, built-in fills, a literal fill, and a `gradient` shader. Opening migrates once: ids and geometry are preserved, each page keeps its own token value, built-ins become source-bound tokens that follow the design theme, the legacy keys are left untouched, and reopening does not migrate again. Evidence: `document-architecture.mjs` check 9, `packages/repo-engine/tests/file-migration.test.ts`, `apps/web/src/features/files/service.test.ts`.

### AT-DOC-006: Stale local tabs

Open one file in two tabs and edit in both. The second write is refused by the revision check, the stored content keeps the first tab's change, and reloading the stale tab shows the stored state. Evidence: `document-architecture.mjs` check 8, `service.test.ts` stale-write cases.

### AT-DOC-007: Independent viewing state

Editor appearance is a user preference. The active page, preview theme, and per-page cameras are per-file view state stored separately from the design file. Switching files restores each file's view; the design file never carries any of it. Evidence: `apps/web/tests/theme-separation.mjs`, `apps/web/tests/file-routing.mjs`, `packages/editor/src/features/editor/view-state.test.ts`.

## Appearance

### AT-APP-001: Schema, migration, and persistence

Version 2 files upgrade on read without visible change: fills reverse to bottom-to-top with stable ids and linear gradients keep sRGB interpolation. Save and reopen retain visibility, opacity, mix blend mode, every fill and its order, gradient shape and state, outline, and canonical borders. Unknown keys, invalid blend modes, out-of-range lengths, duplicate fill ids, missing tokens or assets, mixed `all` plus side borders, and over-limit arrays are rejected. Evidence: `packages/repo-engine/tests/appearance.test.ts`, `file-document.test.ts`, `file-migration.test.ts`.

### AT-APP-002: Creation defaults

A click with the Rectangle tool creates exactly 500 x 500 with one visible literal white fill; a drag keeps the dragged size with the same fill. Frame, Text, Shape, Shader, and component creation are unchanged. Evidence: `packages/editor/src/features/editor/document-store.test.ts`, `apps/web/tests/appearance.mjs`.

### AT-APP-003: Rendering

Two solid fills render bottom-to-top and reorder changes pixels; a hidden top fill reveals the next fill without deleting it; linear, radial, and conic gradients render with their interpolation; per-fill blend lists align with layers; one solid text fill maps to `color` and other text fills clip a background; opacity and every blend mode apply to primitive and component roots; outline and each border side render independently; image fills resolve only through the trusted local asset map. Evidence: `packages/preview-runtime/tests/*`, `apps/web/tests/appearance.mjs`.

A token-bound color can carry an instance opacity override. Rendering multiplies the resolved token alpha by that override without changing the token, detaching the binding, or changing node opacity.

### AT-APP-004: Inspector states and transitions

Eligibility follows the matrix (Text has no Outline or Border); absent, hidden, and removed are distinct; `+` follows the exact Fill, Outline, and Border sequences; mixed values show a mixed state and a replace action that changes every eligible node in one batch; type switching restores cached state; a multi-node edit is one undo step; gradient and reorder drags commit once and Escape restores with no history. Evidence: `appearance-adapters.test.ts`, `document-store.test.ts`, `apps/web/tests/appearance.mjs`.

When a solid fill color is token-bound, its fill opacity field remains editable. Committing the field preserves the token id, records one history entry, and survives save and reopen.

### AT-APP-006: Image fill row

Choosing Image for a fill without cached image state selects the bundled `flowers.webp` asset at 1600 by 1200. The fill row shows a 42 by 32 thumbnail, filename, dimensions, and an `Edit` overlay on hover and keyboard focus. The thumbnail opens the image picker. No separate replace, intrinsic-size, or fit control is rendered.

### FILE-ASSET-002: Image format normalization

The picker accepts image inputs up to 25 MB. AVIF, PNG, JPEG, GIF, and WebP at or below the canonical 1,500,003-byte embedded preview limit keep their original bytes. HEIC and HEIF convert to JPEG at quality 0.92, including files identified by extension when the browser supplies an empty or generic MIME. Supported static images above the embedded limit and other browser-decodable image formats convert to bounded WebP before attachment. Animated GIF and WebP bytes are never silently flattened; an animation above the embedded limit adds no asset and surfaces the exact supported-type and limit error through the document toast channel. Invalid, deceptive, undecodable, and irreducible files also add no asset and surface their error through that channel.

### AT-APP-005: Component preservation and editor chrome

Imported components stay real React components with working props, slots, and Interact mode; appearance overrides apply to the existing root without wrappers and component-owned inline styles are restored when an override is removed; Canvas2D selection chrome stays visible with a document outline, follows transient move and resize geometry while the pointer remains held, and the preview keeps `renderChrome: false`. A collaborator selection on the same locally manipulated node uses that live geometry instead of leaving a stale outline at the saved position. Evidence: `packages/preview-runtime/tests/selection-electron.mjs`, `apps/web/tests/appearance.mjs`, `apps/web/tests/transient-move.mjs`, `packages/editor/src/features/collaboration/CollaborationPresence.test.ts`.

## Font family picker

### FONT-CATALOG-001: Background catalog

The editor starts with system and already loaded families, then adds a catalog generated from official Google metadata asynchronously without blocking workspace startup. The catalog contains family, style, weight, and variable-axis metadata and is emitted as a separate production chunk. Choosing a Google family fetches and verifies the requested face in the background, caches it for the workspace session, and transfers bounded font data through the isolated preview protocol. Evidence: `packages/editor/src/features/fonts/font-catalog-service.test.ts`, `packages/preview-runtime/tests/protocol.test.ts`, `pnpm sync:fonts`, `pnpm --filter @canvas/web build`.

### FONT-LOCAL-001: Local font discovery

Workspace startup checks permission without prompting. A granted permission enumerates in the background. Prompt state requests access only from the picker gesture. The five-second loading deadline changes the UI state but does not discard a late successful result. Disposal cancels ownership and visibility retries. Electron grants only `local-fonts` from the trusted editor main frame and denies every other permission. Evidence: `packages/editor/src/features/fonts/font-catalog-service.test.ts`, `apps/desktop/tests/font-permission.test.ts`.

### FONT-CACHE-001: Session catalog ownership

Closing and reopening the picker does not rebuild the catalog. Favorites and discovered families remain in the workspace service until disposal, and normalized favorites persist for the browser profile. Evidence: `packages/editor/src/features/fonts/font-catalog-service.test.ts`.

### FONT-PREVIEW-001: Resolved family previews

Visible Google families render in their own typeface without waiting for selection. Previews come from generated compressed atlases, never request font files while scrolling, and render only inside the virtualized row window. Atlas images preload at low priority and remain cached by the browser session. Evidence: `packages/editor/src/features/fonts/google-font-preview.test.ts`, `pnpm sync:font-previews`.

### FONT-PICKER-E2E-001: Popup interaction

Open the font family field. A 300 by 444 popup opens 12 pixels left of the inspector and focuses search. Fonts is always present; Favorites and Tokens appear only when populated. Search is fuzzy, rows are virtualized at 36 pixels, arrow keys and Home or End keep the active row visible, Enter chooses and closes, the first Escape clears a query, and the second Escape closes. The favorite target is 34 pixels and does not move selection. Verify light and dark portal theming.

### TEXT-FORMATTING-DROPDOWNS-001: Nested shared selects

Open Formatting and then open Wrap or Line height unit. Both controls use the shared appearance select, remain above the formatting panel, support keyboard selection, and keep the parent panel open while choosing a value.

### FONT-MATCH-001: Per-node style preservation

Choose a family for a mixed text selection. Every node keeps its own closest compatible italic state and weight instead of receiving one shared style. A missing document family remains listed and marked unavailable. Evidence: `packages/editor/src/features/editor/text-inspector.test.ts`.

### FONT-FEATURES-001: OpenType feature controls

Open Features for a font with GSUB or GPOS features. The panel shows only supported features in Paper's category order, uses the font's names for stylistic sets and character variants, previews each Off or On state on hover, and commits one sparse override per change. Standard defaults such as ligatures and kerning begin On. Overrides survive undo, redo, save, reload, text editing, and isolated preview rendering. Evidence: `packages/editor/src/features/fonts/font-feature-worker.ts`, `packages/editor/src/features/editor/text-inspector.test.ts`, `packages/preview-runtime/tests/appearance-styles.test.ts`.

### TEXT-FORMATTING-001: Formatting panel

Open Formatting for one or more text nodes. The popup matches the Paper control order and preview treatment for alignment, case, wrap, keep words, and truncation. Hover previews do not write the document. Selecting a value commits through the text-properties command, preserves mixed state honestly, and produces one undo entry. Evidence: `packages/editor/src/features/editor/text-inspector.test.ts`, `packages/editor/src/design-system/typography-atoms.tsx`.
