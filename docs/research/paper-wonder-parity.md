# Paper and Wonder parity audit

Date: 2026-10-09

This report compares the current Design editor implementation with the live Paper and Wonder products and their publicly delivered web and installed desktop bundles. It ignores Paper chat. It is an implementation audit, not permission to copy proprietary source.

## Evidence legend

- `[LIVE]` Observed in the current product UI without changing third-party state.
- `[BUNDLE]` Found in a publicly delivered web bundle.
- `[DESKTOP]` Found in an installed desktop bundle or application metadata.
- `[PRIOR LIVE]` Rechecked against preserved hands-on research from 2026-10-06 through 2026-10-08.
- `[REPO]` Observed in this repository on 2026-10-09.
- `[INFERENCE]` A conclusion supported by evidence but not directly declared by the product.

The products are moving targets. Bundle filenames and endpoint implementations can change. Exact text and URL strings below are evidence snapshots, not stable contracts.

## Executive verdict

Paper is the stronger interaction and surface model for this editor. Its file finder, compact editor shell, direct-manipulation inspector, tokens, menus, and visual density are the closest reference for the requested product. Wonder is the stronger reference for repository ownership, isolated previews, deep links, desktop Git, update handling, runtime inspection, and refusal of ambiguous source edits.

The right parity target is therefore:

- Paper for home, editor chrome, control grouping, menus, selection behavior, and token ergonomics.
- Wonder for desktop architecture, repository/worktree management, preview containment, source identity verification, deep links, update lifecycle, and operational diagnostics.
- Design editor's own stricter source transaction and component identity model for writes. Paper's tested component imports did not preserve enough code identity or behavior to serve as the source-of-truth architecture.

The repository already has the beginnings of the correct hosted service split, Better Auth desktop flow, R2 assets, revision sync, GitHub App domain model, source-write review flow, and thumbnail jobs. The highest-risk gap is that the visible product still crosses from those real systems into fixture-bound component previews and incomplete end-to-end repository sync.

## Comparison matrix

| Area | Paper evidence | Wonder evidence | Current Design editor | Parity judgment |
| --- | --- | --- | --- | --- |
| Home and files | `[LIVE]` Recents, search, grid/list, new file, file metadata, presence, Files, Archive, Settings | `[PRIOR LIVE]` Project and editor navigation is repository-centered | `[REPO]` Home, search, grid/list, create/open, relative dates, thumbnail URLs | Good shell. Missing the surrounding file lifecycle and account surfaces. |
| Authentication | `[LIVE]` Hosted WorkOS screen with email and Google; desktop callback returns through `paper://` | `[DESKTOP]` Hardened sign-in view and nonce-backed desktop routes | `[REPO]` Better Auth, GitHub provider, PKCE-style Electron client, protected main-process storage, callback protocol | Structurally strong. Packaged callback and failure-state acceptance remain release blockers. |
| Editor shell | `[LIVE]` Narrow layers left, canvas center, inspector right, compact tools and actions | `[LIVE]` Similar three-pane editor with mode-dependent inspector | `[REPO]` Same broad shell and shared design-system primitives | Close, but home/editor continuity and unsupported-action treatment need polish. |
| Layout and sizing | `[LIVE]` Fixed/Fit menus attached to width and height, concise flex controls | `[LIVE]` Freeform/Flex/Block/Grid, fixed/relative/hug/fill/auto/calculate, min/max | `[REPO]` Dedicated layout panels cover flex, grid, position, sizing, gap, spacing, overflow | Functionally broad. Control density and state-dependent visibility should follow Paper more closely. |
| Appearance | `[LIVE]` Fill, outline, border, shadow, inner shadow, filters, export; token opacity remains editable | `[LIVE]` Background fill, border, outline, shadow, filters, mask, export | `[REPO]` Rich fills, gradients, images, border, outline, blending and color-token opacity exist | Core model is strong. Remaining section coverage and visual hierarchy should be audited in the running app. |
| Tokens | `[LIVE]` Tokens and bound styles update live; modes exist in schema | `[LIVE]` Variables are integrated into color and numeric control menus | `[REPO]` Repository scanner and theme panel import source tokens; numeric layout tokens exist | Expand beyond the current color-centric source workflow into kinds, modes, groups, and aliases. |
| Components | `[PRIOR LIVE]` Imported HTML/component shapes lose meaningful source identity in tested paths | `[PRIOR LIVE]` Component and source inspection are guarded by structural verification | `[REPO]` Scanner finds components and a sync queue exists, but insertion is still fixture-catalog constrained | This is the largest user-facing parity gap. Preserve real TS component identity, props, slots, providers, and portals. |
| Menus and popovers | `[LIVE]` Compact portaled menus and property-attached submenus | `[LIVE]` Portaled Bits-style menus and pickers, virtualized trees | `[REPO]` Context-menu root and submenu both portal | Architecture is correct. Finish missing actions and align sizing/placement through shared primitives. |
| Repository and sync | No first-class repository round trip was found in tested Paper UI | `[DESKTOP]` Managed clones/worktrees, bundled Git, wrapped environment, source inspection | `[REPO]` Desktop-only repository panel, scanner, source transaction, GitHub backend | Back end is promising. Visible connection, pull/watch, review, save, and push flow is not yet coherent end to end. |
| Thumbnails | `[BUNDLE]` Stable AVIF key under workers file assets | No equivalent public contract established | `[REPO]` R2 keys and thumbnail jobs exist, but renderer is hardcoded to fixtures | Replace fixture imports with the file's real component registry and fonts. |
| Downloads and updates | `[DESKTOP]` Public stable installer and ToDesktop generic update feed | `[DESKTOP]` Branded platform URLs and ToDesktop update feed | `[REPO]` Service topology exists, but no complete release/download/update product surface was confirmed | Use branded stable URLs backed by signed artifacts and a generic feed. Application installers were not GitHub Releases in either reference. |

## Paper findings

### Home and file finder

`[LIVE]` The home surface is a file finder, not an editor startup dialog. It contains:

- account identity in a fixed left rail;
- search with a visible keyboard shortcut;
- Recents, Learn, Files, Archive, and Settings destinations;
- a team section and invite action;
- a `Get desktop app` action plus What's new and Feedback;
- a sticky Recents toolbar with `New file` and grid/list toggles;
- file cards or rows with file name, edited time, created time, creator, and active presence where available.

`[LIVE]` Card thumbnails show an overview of the spatial document rather than a generic icon. Blank files can have empty thumbnails. List mode preserves the same file identity and metadata without thumbnails.

`[BUNDLE]` The thumbnail helper resolves to:

```text
https://workers.paper.design/file-assets/thumbnails/<fileId>/thumbnail.avif
```

The observed helper string is equivalent to `WORKERS + "/file-assets/thumbnails/" + fileId + "/thumbnail.avif"`.

### Hosted and desktop authentication

`[LIVE]` An anonymous request to `https://login.paper.design/` redirects to WorkOS AuthKit. The delivered page offered email and Google. It carried:

```text
redirect_uri=https://api.paper.design/auth/callback
authorization_session_id=<opaque id>
state={"redirectAfterSuccessUrl":"https://app.paper.design"}
```

`[DESKTOP]` Paper desktop uses a different callback path from the ordinary web callback:

1. Generate a WorkOS PKCE authorization URL.
2. Use `${WORKERS}/auth/desktop-redirect?protocol=paper` as the redirect URI.
3. Keep the code verifier in desktop memory.
4. Open the system browser with Electron `shell.openExternal`.
5. Receive `paper://auth/callback?code=...` through `open-url`, `second-instance`, or the initial process arguments.
6. Show `/static/desktop/preloader.html` while exchanging `{ code, codeVerifier }` at `API/auth/desktop-callback`.
7. Receive a sealed session, cosmetic user information, and the route to open.
8. Set the sealed session as an HttpOnly cookie and the cosmetic value as a readable cookie, then focus and restore the window.

`[DESKTOP]` The desktop parser accepts production and development schemes. Callback ownership is process-level and routing is handled before the editor loads. Failed exchanges route to a product error page rather than leaving the editor half-authenticated.

### Editor shell and inspector

`[LIVE]` Paper uses a compact three-pane shell. The left panel is pages and layers, the middle is a large dark canvas, and the right panel is a property inspector. Tools and primary actions are icon-led and use short labels.

`[LIVE]` Inspector controls are conditional. Width and height each own a small attached menu. A fixed item offers `Fixed` and `Fit` in that menu. Flex-container controls appear only when the selected node's state supports them. Absolute placement is an attached toggle rather than a large segmented control.

`[LIVE]` Paper's flex surface includes direction, alignment, distribution, wrap, gap, padding, and compact split-side affordances. Numeric variables appear in eligible number menus. When no numeric variables exist, the variable affordance is not useful and should not be shown.

`[PRIOR LIVE]` Observed layout behavior includes hierarchy, grouping, duplicate, reorder, snapping, flex direction, padding, gap, fixed/fit/fill sizing, wrap, absolute positioning, and clipping. Token-bound styles propagate from their token. Literal styles remain independent.

### Appearance and tokens

`[LIVE]` Paper's appearance sequence is Blending, Fill, Outline, Border, Shadow, Inner shadow, Filters, and Export. Each paint row keeps color, token binding, opacity, visibility, and unlink actions on one visual line where space permits.

`[LIVE]` A token-bound fill still exposes the paint opacity. Opacity belongs to the paint application, not the token definition, so changing it must not unlink or mutate the token.

`[BUNDLE]` The current public schema includes optional token theme modes. A `Publish as a library` path is present but gated off at the inspected production origin by the `tokens_library_publish` feature flag.

`[PRIOR LIVE]` Paper supports copy outputs labeled `Copy as Tailwind` and `Copy as React CSS`, including keyboard shortcuts. The tested outputs were generic markup. They did not demonstrate source-preserving round-trip identity.

### Components and source fidelity boundary

`[PRIOR LIVE]` Pasted/imported HTML was useful as a visual starting point but did not preserve class-only styling, behavior, semantic input identity, or rich mixed text reliably. Duplicates behaved independently. No definition/instance model equivalent to a code component was established in the tested flow.

`[INFERENCE]` Paper should therefore be copied for interaction design, not for the source-of-truth model. Design editor's component identity, provenance, and reviewed write transaction are stricter and should remain stricter.

### Collaboration presence and following

`[BUNDLE]` The 2026-10-10 collaboration audit inspected `https://app.paper.design/assets/main-CkqFojyn.js` with SHA-256 `9F54B8F57C1B043FD7F0AB5B74B6AB2242DD2FA28461DBD0D109BF3E157F7BEA`. The current editor collaborator strip renders the local user first, up to two agent identities, and up to four remote people. It collapses only when at least two identities are hidden. Human avatars are 22 px circles with 4 px overlap. The local tooltip is `<name> (you)` and remote tooltips use the collaborator name. The identity anchors are `Tbe=ue` at byte offset 2472205, avatar base `EE` at 2474204, human `mR` at 2474443, agent `Hne` at 2475398, and limits `yR=4,bR=2` at 2475691.

`[BUNDLE]` Clicking a remote person starts camera follow. Paper's exact visible labels are `following {name}` and `stop following`; no `watching` label was found. Follow state tracks the remote page and camera, hides the panels, renders a boundary in the person's stable color, restores the prior panel state on exit, and stops on local pan or zoom or when the followed person leaves. The follow label anchor is `iUt` at byte offset 3963611. Local pan and scale stop paths begin near offsets 1230677 and 1231028, and the panel capture and restore paths begin near 2219644 and 2220238.

`[BUNDLE]` Paper handles its initial roster, join, leave, page, focus, selection, camera, and cursor messages as ephemeral multiplayer state. Routine awareness traffic is suppressed in single-player mode. Cursor and camera publication is throttled to roughly 33 Hz, cursors and selections render only on the active page, and selection emphasis drops while the remote editor is blurred. Cursor interpolation and snap behavior is anchored by `fOt` at byte offset 3297224. Selection rendering is anchored by `cOt` and `uOt` near 3296375 and 3296429. Join and leave update the roster without a toast; the roster mutations are anchored by `XWe` at 495476 and `KWe` at 495535, with dispatch `d$e` at 500817.

`[BUNDLE]` Read-only access remains in the regular editor shell. Paper hides the right panel and shows `You can only view this file` with `To edit, ask the owner to add you as an editor`. The read-only notice is anchored by `oUt` near byte offset 3962889. No separate viewer or spectator avatar icon was found in the inspected bundle.

`[REPO]` Design editor now has a real ephemeral presence protocol with authoritative roster, join, leave, and awareness handling. Its identity strip uses Paper's right property-panel header placement, visible and overflow limits, themed identity tooltips, ordinary human avatars for viewers, cursor focus treatment, exact follow copy, panel-hiding follow frame, and read-only shell copy. The remaining authority work is stable local identity and access across reconnects plus end-to-end viewer enforcement. Agent identities must remain absent until a real producer supplies them; decorative local agents are prohibited.

### Web services and static assets

`[BUNDLE]` The inspected production environment declared:

```text
SYNC=wss://sync.paper.design
API=https://api.paper.design
ASSETS=https://assets.paper.design
WORKERS=https://workers.paper.design
CLIENT_SIGNALS=https://signals.paper.design
FILE_ASSETS=https://app.paper.design
COOKIE_DOMAIN=.paper.design
EMAIL_DOMAIN=emails.paper.design
WEBSITE=https://paper.design
MAIN_APP=https://app.paper.design
```

`[BUNDLE]` Other observed infrastructure includes `cdn-ph.paper.design` for PostHog delivery and a WorkOS image CDN. Paper exposes current-file browser model-context tools and a separate desktop bridge. The browser tool surface rejects work outside the current file.

### Installer and updater

`[DESKTOP]` `https://download.paper.design/` returned a stable Windows installer endpoint:

```text
Paper Setup 0.5.15 - x64.exe
Content-Type: binary/octet-stream
Content-Length: 125544656
```

`[DESKTOP]` Installed metadata uses a ToDesktop generic update provider at `https://download.todesktop.com/2601167vjw8xe`. The installed desktop package was version `0.5.15`, registered `paper` and `paper-dev` protocols, and used ToDesktop's runtime updater. The web bundle checks `/version.json?t=<timestamp>` and uses a desktop bridge for `getAvailableUpdate` and `quitAndInstallUpdate`.

`[INFERENCE]` The application installer is not visibly delivered from GitHub Releases. A stable branded download URL fronts the binary, while the app updater reads a generic ToDesktop feed.

## Wonder findings

### Editor shell and exact control states

`[LIVE]` Wonder's shell uses a page/layer rail, canvas, right inspector, avatar/share actions, a compact vertical tool strip, and a zoom control. Chat is intentionally excluded from this audit.

`[LIVE]` With no selection, the inspector shows page-level appearance such as page background and opacity. With a container selected, the inspector exposes:

- Position: resize/align availability, rotate, flip, X, Y, rotation, inset fields where applicable, z-index, and anchors.
- Layout: Freeform, Flex, Block, Grid, plus state-dependent inline behavior.
- Sizing: fixed values and menus for Fixed, Hug, Calculate, min, and max constraints. Other node states expose Relative, Fill, and Auto.
- Flex: row/column, horizontal and vertical gap, a 3 by 3 alignment matrix, Space evenly, Space between, Space around, reverse, wrap, and padding controls.
- Grid: authored tracks and item placement when the selected node is grid-related.
- Appearance: visibility, blend, opacity, radius, per-corner radius, and clip.
- Background Fill: solid, gradient, and image paths with row visibility and removal.
- Border and Outline: style, side, width, offset where relevant, visibility, removal, color, and opacity.
- Shadow, Filters, Mask, and Export sections.

`[LIVE]` Numeric variables are integrated into eligible length controls. Color variables are integrated into the color picker rather than managed in a detached source-only panel.

### Stable UI and menu structure

`[PRIOR LIVE]` Useful stable state hooks include `data-page-id`, `data-layer-node-id`, `data-selected`, `data-active`, and explicit field IDs. Generated Bits IDs and positional selectors are unstable.

`[PRIOR LIVE]` Layer rows are virtualized. Menus and pickers portal out of scroll containers. This avoids submenu clipping and context-menu scrollbars. Visual controls use a 4px rhythm, dark OKLCH surfaces, compact 12px to 16px inspector type, 6px field radii, approximately 14px popup radii, and box-shadow borders.

`[LIVE]` The color picker supports Solid, Gradient, and Image modes, custom colors and variables, HEX/RGB/HSL/OKLCH, eyedropper, copy, and alpha.

### Desktop repository and worktree model

`[DESKTOP]` Wonder stores managed repositories and workspaces at:

```text
~/wonder/repos
~/wonder/workspaces
```

It also uses Electron `userData` directories named `repos` and `worktrees` for application-managed state.

`[DESKTOP]` Clone behavior uses:

```text
git clone --filter=blob:none --no-tags --progress
```

It attempts HTTPS before SSH, supports cancellation with an `AbortController`, and verifies the resulting repository.

`[DESKTOP]` Wonder ships a wrapped Git environment based on Dugite. It sets its own `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_CONFIG_SYSTEM`, `WONDER_GIT_PATH`, Git LFS and helper paths, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, and `GIT_LITERAL_PATHSPECS=1`. macOS worktree operations use `sandbox-exec` write constraints. Wonder identifies its own pull worktrees from a `wonder/pull/<number>` gitdir structure.

`[DESKTOP]` The shipped Git toolchain is Dugite native `v2.53.0-4`, sourced through GitHub release metadata. GitHub CLI `v2.101.0` is also bundled. This use of GitHub Releases is for toolchain binaries, not evidence that the Wonder app installer itself is a GitHub Release.

### Preview containment and structural inspection

`[BUNDLE]` Wonder validates preview URLs, allows only HTTP(S), rejects credentials, normalizes loopback addresses, and assigns distinct policies for published, browser, desktop, and legacy desktop previews. It validates the `.preview.wonder.design` domain where required.

`[DESKTOP]` The desktop bridge is narrow but covers open external, tabs, preview capture, structural inspection, telemetry, fonts, drag/drop, environment, worktrees, diagnostics, relaunch, and publishing operations.

`[DESKTOP]` The structural inspector builds unique selectors and structural signatures, maps peers, records verified/ambiguous/unverified states, applies work budgets and CSS-property validation, and refuses ambiguous writes.

`[INFERENCE]` This is a useful model for runtime-to-source identity. Selection may begin with runtime evidence, but writes should occur only after a unique verified source binding is found.

### Deep links and authentication transport

`[BUNDLE]` The web deep-link helper points users to `https://wonder.design/downloads`, requires a nonce, supports an optional desktop scheme, strips sensitive nonce/return values from the visible route, detects opening through blur/pagehide, and reports timeout after five seconds.

`[DESKTOP]` Production, staging, and development schemes are `wonder`, `wonder-staging`, and `wonder-dev`. Wonder registers the scheme, handles `second-instance`, `open-url`, and initial arguments, and routes nonce-backed payloads through explicit consume/decline IPC. Sensitive handoff values persist for at most 15 minutes and are removed from the visible URL.

`[DESKTOP]` Desktop sign-in uses a locked WebContentsView with a 32px origin strip indicating the secure or insecure host. It enables `contextIsolation`, disables Node integration, and blocks arbitrary navigation and window opening.

### Downloads and updates

`[LIVE]` `https://wonder.design/downloads` exposes branded platform routes:

```text
https://download.wonder.so/mac/dmg/arm64
https://download.wonder.so/mac/dmg/x64
https://download.wonder.so/windows/nsis/x64
```

`[DESKTOP]` These routes returned binaries through Cloudflare. The inspected Windows build was approximately 210 MB. The installed app was `0.2.119` and used ToDesktop build ID `261008c5ma7bbeh`. Its update feed is `https://download.todesktop.com/260604iu721fo`.

`[BUNDLE]` Wonder checks `/version.json` every 60 seconds with cross-tab coordination. A breaking release can begin a 30-second forced-update countdown, but the app attempts to defer restart while editor or chat work is active. Desktop update UI distinguishes latest-version, check-failed, downloading, ready, and restart states.

`[INFERENCE]` The public app downloads are not visibly GitHub Releases. The likely pattern is branded redirect/download service plus a signed application build pipeline and generic updater feed.

## Current Design editor implementation

### Home and file lifecycle

`[REPO]` `packages/editor/src/features/home/HomeView.tsx:26` implements search, grid/list state, new file, open, progress phases, empty and error states. `packages/editor/src/design-system/home-atoms.tsx:15` through `:50` supplies named home atoms rather than raw route markup. `packages/editor/src/features/application/HomeScreen.tsx:22` connects auth identity and file capabilities. `packages/editor/src/features/home/store.ts:42` creates files through the selected adapter.

`[REPO]` `apps/web/src/adapters/cloud.ts:91` already maps a stored thumbnail key to the Paper-like AVIF URL shape under `file-assets/thumbnails/<id>/thumbnail.avif`. File creation is enabled in the cloud capability set.

The current home is a credible base, but it is only the Recents/Files core. It does not yet equal Paper's complete file lifecycle, navigation, archive, settings, team, invitation, desktop download, What's new, feedback, presence, or rich list metadata.

### Auth

`[REPO]` `packages/auth/src/index.ts:3` declares `com.comp-canvas.desktop` and `/auth/callback`. `packages/auth/src/electron.ts:82` owns the main-process Better Auth client, protected storage, sign-in request, callback exchange, session fetch, and sign-out. Tokens and the auth client do not cross preload.

`[REPO]` `apps/desktop/src/main/auth-service.ts:82` validates the native callback against the pending attempt, its owner window, and expiry. It maps denied, offline, revoked, expired, invalid, and unknown failures to distinct session states. `apps/desktop/src/main/index.ts:48` queues callbacks until the auth service is ready and handles initial arguments, `second-instance`, and `open-url`.

`[REPO]` `packages/editor/src/features/auth/DesktopAuthBoundary.tsx:11` owns signed-out, signing-in, authenticating, and error display. `HostedSignInScreen.tsx:14` currently exposes a GitHub-first hosted sign-in surface.

This architecture is stricter than Paper's renderer-visible cookie handoff. The remaining concern is empirical: the packaged callback needs an end-to-end acceptance test proving protocol registration, browser return, pending-state recovery, full-screen loading, protected token persistence, and useful failure details.

### Layout and appearance

`[REPO]` `packages/editor/src/features/editor/LayoutPanels.tsx:46` resolves numeric layout tokens. The file contains dedicated position, sizing, container, flex, gap, overflow, grid, child, padding, and margin controls. State is derived across multi-selection rather than guessed from one node.

`[REPO]` `packages/editor/src/features/editor/AppearancePanels.tsx` supports blending, solid/gradient/image paints, paint opacity, token rebinding/unlinking, borders, outlines, and multi-selection aggregation. `packages/repo-engine/src/appearance.ts:320` applies paint opacity independently from the underlying color value. This is the correct model for token-bound opacity.

`[REPO]` `packages/editor/src/features/editor/ThemePanel.tsx` edits and resolves file tokens, while repository source tokens are imported from `RepositoryPanel.tsx`. Current repository discovery and import remain more color-centric than the reference products' integrated variable menus.

### Menus

`[REPO]` `packages/editor/src/design-system/context-menu.tsx:81` portals submenus, and `:119` portals the root menu. The overflow-captured submenu bug has the correct architectural fix. `packages/editor/src/features/editor/NodeContextMenu.tsx:82` contains the Copy as submenu. React is active, Tailwind is still disabled, and group-related commands remain incomplete.

### Repository, components, and source writes

`[REPO]` `packages/editor/src/features/editor/RepositoryPanel.tsx:12` is desktop-only through capabilities. It can choose a local repository or clone, show scan diagnostics, list discovered components, and import source tokens. The clone form is still owner/name oriented rather than a complete GitHub App repository picker.

`[REPO]` `packages/editor/src/features/editor/ComponentLibrary.tsx:31` calculates insertion destinations and `:49` renders the library. `:35` and `:40` still contain `Card`-specific naming behavior, which is a visible fixture-era special case. A component sync queue exists for browser-authored components.

`[REPO]` The source-write path is substantially more complete than the visible scanner flow. `packages/editor/src/features/editor/store.ts:265` prepares a patch, `:282` requires explicit approval and passed validation, and `:286` saves using an approval digest. It invalidates prepared changes on edits and external snapshots. `apps/desktop/src/main/policy.ts:87` constrains `savePrepared` arguments. `packages/repo-engine/src/document-persistence.ts:87` uses revision, hash, and lock checks for document saves. Tests cover same-revision external byte changes and leave external contents intact.

The missing product bridge is a reliable cycle from scanned real component to isolated preview, explicit Instance/Shared component/Token edit scope, smallest source patch, review, atomic save, identity reconciliation, repository watch, and optional Git operation.

### Hosted services and storage

`[REPO]` `apps/api/src/app.ts` routes hosted auth, files, GitHub, thumbnail source/access/metadata/upload/commit, and job claims. `apps/api/src/github.ts` implements OAuth/App grants, installation authorization, token minting, webhooks, repository jobs, and actor resolution backed by PostgreSQL.

`[REPO]` `packages/files/src/r2.ts:106` implements an R2 binding asset store. R2 is suitable for private thumbnails and immutable file assets. It should not be used as the authority for mutable file revisions, sessions, GitHub grants, or sync ordering. Those belong in PostgreSQL and the sync service.

`[REPO]` The repository already separates API, web, workers, sync, thumbnail jobs, thumbnail renderer, auth, files, GitHub App, cloud client, preview runtime, repo engine, scanner, and UI packages. This is directionally consistent with Paper's API/workers/assets/sync separation. The distinction should be preserved in deployment even when services share a monorepo.

### Thumbnail limitation

`[REPO]` `apps/thumbnail-renderer/src/main.ts:8` through `:11` imports Button, Card, Input, and Label from a test fixture. Its registry at `:25` is hardcoded. `apps/thumbnail-renderer/vite.config.ts:6` and `apps/web/vite.preview.config.ts:6` repeat the same fixture allowlist.

This means the service topology is real but the rendering catalog is not yet repository-derived. A file containing a newly scanned component cannot be trusted to render accurately in home thumbnails until the renderer builds from the file's exact component bindings, providers, fonts, styles, and assets.

## Priority parity gaps

### P0: release-blocking product paths

#### P0.1 Replace the fixture component registry

Anchors:

- `apps/thumbnail-renderer/src/main.ts:8`
- `apps/thumbnail-renderer/src/main.ts:25`
- `apps/thumbnail-renderer/vite.config.ts:6`
- `apps/web/vite.preview.config.ts:6`

Required outcome: generate an isolated preview registry from verified repository bindings. Resolve exact exports, styles, providers, fonts, and static assets. Refuse unsupported imports rather than substituting a shell. Use the same registry for the editor preview and thumbnail renderer so thumbnails cannot drift from the canvas.

#### P0.2 Make scanned components real insertable TypeScript components

Anchors:

- `packages/editor/src/features/editor/RepositoryPanel.tsx:12`
- `packages/editor/src/features/editor/ComponentLibrary.tsx:31`
- `packages/editor/src/features/editor/ComponentLibrary.tsx:35`
- `packages/editor/src/features/editor/ComponentLibrary.tsx:49`

Required outcome: a scan result preserves file, export, stable component identity, typed props, defaults, variants, slots, styles, providers, and portal requirements. Insertion creates an instance of that identity. Remove the `Card` special case. Unsupported props must produce a precise reason and cannot be silently dropped.

#### P0.3 Complete the repository sync loop

Anchors:

- `packages/editor/src/features/editor/store.ts:53`
- `packages/editor/src/features/editor/store.ts:265`
- `packages/editor/src/features/editor/store.ts:282`
- `apps/desktop/src/main/repo-worker.ts:30`
- `apps/desktop/src/main/policy.ts:87`

Required outcome: local file changes trigger reparse, binding reconciliation, preview rebuild, and explicit conflicts. Design edits remain transient until review and Save. Save rechecks hashes, writes all files atomically or rolls back all of them, rebuilds, and reconciles identities. Git commit and push must remain separate explicit actions.

#### P0.4 Prove packaged desktop auth

Anchors:

- `packages/auth/src/electron.ts:82`
- `apps/desktop/src/main/auth-service.ts:82`
- `apps/desktop/src/main/index.ts:48`
- `packages/editor/src/features/auth/DesktopAuthBoundary.tsx:11`

Required outcome: an automated packaged-app acceptance test crosses system browser, custom protocol, main process, protected storage, API exchange, and renderer session state. It needs negative controls for wrong state, wrong window, expired pending attempt, denied provider, offline API, and replayed callback. The renderer should show the full-screen authenticating state during exchange and a specific recoverable failure afterward.

#### P0.5 Connect the GitHub App to repository selection

Anchors:

- `apps/api/src/github.ts:54`
- `packages/editor/src/features/editor/RepositoryPanel.tsx:12`

Required outcome: sign in, install/connect GitHub App, list only authorized repositories, choose a repository, mint a short-lived installation token in the server, and hand a scoped clone job to desktop. The renderer must never receive a long-lived provider or installation credential.

#### P0.6 Finish cloud file sharing and authorization

Anchors:

- `packages/editor/src/features/editor/Editor.tsx:37`
- `apps/api/src/app.ts:48`
- `apps/web/src/adapters/cloud.ts:95`

Required outcome: Share reflects server-enforced file roles, revocation, link states, and session invalidation. Every file, share, asset, thumbnail, and sync operation must enforce object authorization. Do not expose a decorative Share action before the policy is real.

### P1: main parity work

#### P1.1 Complete the Paper-like home ecosystem

Anchors:

- `packages/editor/src/features/home/HomeView.tsx:26`
- `packages/editor/src/design-system/home-atoms.tsx:15`
- `packages/editor/src/features/application/HomeScreen.tsx:22`

Add Files, Archive, Settings, account/team surfaces, invite, Get desktop app, What's new, Feedback, creator/created/presence metadata, and empty/archive states. Keep route files free of raw markup and extend the named home atoms and molecules.

#### P1.2 Generate real thumbnails

Anchors:

- `apps/thumbnail-renderer/src/main.ts:53`
- `apps/thumbnail-jobs/src/index.ts`
- `packages/files/src/r2.ts:106`
- `apps/web/src/adapters/cloud.ts:91`

Render a deterministic overview of actual page frames and repository components. Wait for fonts, images, and preview readiness. Store private AVIF assets under stable per-file keys. Update metadata only after upload commit. Include stale-job and unauthorized-source negative tests.

#### P1.3 Extend variables beyond color imports

Anchors:

- `packages/editor/src/features/editor/LayoutPanels.tsx:46`
- `packages/editor/src/features/editor/ThemePanel.tsx`
- `packages/editor/src/features/editor/RepositoryPanel.tsx:12`

Support number, dimension, radius, typography, shadow, alias chains, groups, and modes where scanner provenance is verified. Integrate values into eligible controls. Hide variable affordances when no compatible values exist.

#### P1.4 Complete component semantics

Anchors:

- `packages/editor/src/features/editor/ComponentLibrary.tsx:31`
- `packages/repo-engine/src/document.ts`

Expose definitions, instances, variants, props, slots, event/behavior ownership, and unsupported dynamic expressions honestly. Promotion must create a real source component importing existing atoms, then rebind the canvas instance.

#### P1.5 Harden runtime-to-source selection

Anchors:

- `packages/preview-runtime`
- `packages/repo-engine`

Adopt the useful Wonder properties: a stable source binding, structural signature, peer evidence, verification state, time/work budget, and refusal when multiple source nodes remain plausible. Do not depend on React private fiber fields.

#### P1.6 Ship download and update surfaces

Anchors:

- deployment configuration for web and desktop;
- desktop main-process update service when added;
- home `Get desktop app` action when added.

Use branded stable platform URLs and signed artifacts. Publish a version manifest and updater feed independently from the marketing route. Defer restart while unsaved design or source-review work exists. Show latest, checking, downloading, ready, failed, and restart states.

### P2: completeness and polish

- Enable truthful `Copy as Tailwind` only after output validation. Anchor: `packages/editor/src/features/editor/NodeContextMenu.tsx:82`.
- Finish group/ungroup and other disabled node commands with correct selection and undo semantics. Anchor: `NodeContextMenu.tsx`.
- Add home sort, list columns, presence, archive restore, and robust keyboard navigation.
- Audit remaining appearance sections, including inner shadow, filters, mask, and export, in the running product against the shared inspector primitives.
- Continue theme drift checks through the installed Wonder theme contract. New controls should extend existing atoms and molecules rather than paste screenshot CSS.

## Acceptance-test mapping

The existing acceptance plan already names the required proof. Parity work should extend these tests instead of creating screenshot-only alternatives.

| Gap | Acceptance tests |
| --- | --- |
| Real scanned components and shared preview registry | `AT-P0-001`, `AT-P0-002`, `AT-SCAN-001`, `AT-COMP-001`, `AT-PRV-001`, `AT-APP-005` |
| Incremental repository pull and reviewed source push | `AT-SYNC-001`, `AT-SYNC-002`, `AT-ID-001` through `AT-ID-003`, `AT-SRC-001` through `AT-SRC-006` |
| Desktop auth and GitHub App connection | `AT-AUTH-001`, `AT-AUTH-002`, `AT-AUTH-003`, `AT-GHAPP-001`, `AT-REPO-LINK-001`, `AT-SEC-001`, `AT-SEC-002` |
| File home, creation, shell, and recovery | `AT-DOC-001`, `AT-UX-001`, `AT-UX-002`, `AT-UX-003`, `AT-PERF-002` |
| Private assets and deterministic thumbnails | `FILE-ASSET-001`, `FILE-ASSET-SEC-001`, `AT-THUMB-001` |
| Hosted revision sync and authorization | `CLOUD-SYNC-CLIENT-001`, `CLOUD-SYNC-CONFLICT-001`, `CLOUD-SYNC-PG-001`, `CLOUD-SYNC-AUTH-001`, `CLOUD-SYNC-LIFECYCLE-001` |
| Layout and inspector parity | `AT-CAN-002`, `AT-CAN-003`, `AT-APP-003`, `AT-APP-004` |
| Repository token import and integrated numeric variables | `AT-TOK-001`, `AT-REPO-TOKEN-001`, `AT-REPO-TOKEN-002` |
| Share behavior | `AT-SHARE-001`, `AT-SHARE-002`, `AT-UX-004` |

## Recommended delivery sequence

1. Replace the fixture registry with a generated verified component registry shared by preview and thumbnail rendering.
2. Connect repository scan results to real instances with typed props, slots, providers, and explicit unsupported states.
3. Close the watch, preview, review, atomic Save, reconcile loop and prove it with real repository fixtures.
4. Prove packaged desktop auth and GitHub App repository selection across real boundaries.
5. Make cloud files, thumbnails, sharing, and authorization production-complete.
6. Expand home and inspector parity using the current shared Wonder-theme design system.
7. Add branded downloads and idle-aware updates once signed release artifacts exist.

This order keeps the visually attractive surfaces attached to truthful runtime and source behavior. It also avoids building a polished file finder whose thumbnails and components still come from the fixture catalog.

## Preserved evidence inventory

Disposable excerpts and downloaded public assets are under `.tmp/paper-wonder-research`. They are research evidence only and must not be shipped.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `paper-main-CkqFojyn.js` | 4,043,039 | `9F54B8F57C1B043FD7F0AB5B74B6AB2242DD2FA28461DBD0D109BF3E157F7BEA` |
| `paper-client-Bz0wzmr7.js` | 194,910 | `439EF3056D6EB05DEE832BA6526DA6EAF35808C9B469DF815BFDD8BA625C1579` |
| `paper-MCPHandlers-DKdNeZRd.js` | 191,760 | `D229472D9AC3B0FFCF2FB065942A57FED89B5C112E72ED78C00BA146377A5BA8` |
| `paper-code-import-BNRML78C.js` | 33,084 | `082508E652B593C1A9747A3D25DEE26E406A3C9BB334B024249CF1C3C6B0A889` |
| `paper-index-DtkxL5QJ.css` | 267,046 | `5043F57080F9D171212657E2275C527CE6B42ABFBFE1618F04EDC8EC41C3FE97` |
| `wonder-index-DSRRjWKk.js` | 687,048 | `14EFA846B80E43D8B3D3A0607509D5C0C51A3191F5B586D86B9C0952D1A08D53` |
| `wonder-index-3VkjStaP.css` | 228,338 | `739DB1D6F6C1A9386D9DA165199682DF28F3B8A0121EB5F142877B652981C02E` |
| `wonder-desktop-bridge-D7T7Xo4Y.js` | 46,838 | `00E7ACA521914548E88454803CFF988EC1461BE936469E7A92AC268DBE9111AC` |
| `wonder-deep-link-scheme-ChwZFppb.js` | 2,950 | `21D277C5039F358E749E4816C564AA524AFDDA36FDE345ABAFB3E324C92FC9B6` |
| `wonder-live-preview-url-CztZWNwz.js` | 3,311 | `CC5B23504B7CB62C0DCFAF38C66600B21EB5825192442E4126E1270AA211ED33` |
| `wonder-releaseCheck.svelte-mtnmE9SM.js` | 8,912 | `647389A8FEDC2FE0CAA0A9C73A69940029DF8ABFAAAD04697C54EF3F65ADC8B7` |
| `wonder-desktopUpdate.svelte-CbhdFucu.js` | 3,815 | `F1CDD780236177243D42004E10AD9057430DD0D072C1F15A9940339FF197E963` |
| `wonder-storage-DKMaqGJ-.js` | 3,600 | `09CF1612A2F805D6CF6B3EF33B45167F40660AFC24CDC8D800735A00D3A41518` |
| `wonder-create-and-open-file-BdY3PwRN.js` | 2,645 | `DB6D20AD7AE634A6CD13C98B6CACE3A733FAD717BE5B96C5A516FE71D87A956C` |
| `wonder-workspace-checkout-actions-DvXuAZ8X.js` | 5,033 | `7AB5E4563DFFA7502159443AEC3D0881F127F3EFC893EBECD1FB2419F3C9B6D2` |

The exact filenames in the directory may omit the `paper-` or `wonder-` prefix. Match by bundle hash when provenance matters.

## Limitations

- No third-party file, repository, account, or setting was mutated.
- No new Paper or Wonder authentication was performed. Existing public or local installed artifacts were inspected.
- The audit does not claim private server implementation details. Service ownership behind public endpoints is an inference.
- Minified bundle strings establish shipped client behavior, not every server-side guarantee.
- Paper's and Wonder's proprietary code is evidence only. Implementation must be original and follow this repository's security, atomic architecture, no-effects, and source-write rules.
