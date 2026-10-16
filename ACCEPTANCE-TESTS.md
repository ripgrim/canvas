# Acceptance tests

These tests define release evidence. A result is valid only when it uses real fixtures and observable boundaries. Mock-only demonstrations, skipped tests, and assertions derived from production logic do not pass.

## Paper parity program

The detailed behavior matrix and evidence inventory live in `docs/research/paper-parity-integration.md`. These IDs are release gates, not implementation milestones.

### PAPER-TEXT-001 through PAPER-TEXT-008

Verify the stored text model and migration, preview CSS, legacy visual preservation, creation, direct editing, keyboard behavior, resize modifiers and sizing modes, inspector fidelity, semantic undo, and live two-client publication. Use independently authored expected CSS and geometry. Negative controls must reject text-only fields on non-text nodes, malformed typography, stale semantic commits, and read-only edits. Capture screenshots of editing, selection, and every inspector state in light and dark modes.

### PAPER-FLEX-001 through PAPER-FLEX-008

Verify Add flex, Wrap in flex, Remove flex, inference, absolute-child preservation, flow and absolute transitions, the Paper-order inspector, alignment matrix keyboard behavior, gaps, padding, baseline modes, reorder, duplicate, modifier drops, rotated resize, one semantic undo, and live two-client convergence. Add flex remains unavailable through a temporary geometry gap, recovers when a matching packet arrives, and rejects stale document or layout generations. Negative controls must catch world-geometry drift, an absolute child entering flow, direction changes that preserve wrapping, a final commit that differs from the final live state, and more than one undo entry for one gesture. Evidence: `packages/editor/src/features/editor/layout-flex-actions.test.ts`, `packages/editor/src/features/editor/preview-asset-connection.test.ts`.

### PAPER-CLIP-001 through PAPER-CLIP-008

Verify MIME precedence, versioned internal payloads, editable-target bypass, SVG sanitization, image conversion and limits, same-file and cross-file insertion, asset and token reconciliation, placement, Paste on top, Paste to replace, partial multi-image success, one semantic batch, one undo entry, and live two-client convergence. Negative controls must reject scripts, event handlers, external SVG references, over-limit payloads, invalid tree relationships, private asset fields, unauthorized cut or replace, and a paste that commits before every required asset is verified. Evidence: `packages/editor/src/features/editor/editor-clipboard-service.client.test.ts`, `packages/editor/src/features/editor/clipboard-internal.test.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `apps/sync-room-core/tests/network.test.ts`.

## Evidence rules

- Record fixture revision, platform, tool versions, and relevant hashes.
- Compare against independently written expected values or checked fixture bytes.
- Critical tests include a negative control or targeted mutation that must fail.
- Keep screenshots, recordings, diffs, and diagnostics with the test result.
- Label unsupported adapters as unsupported. Do not rerun against a different adapter and claim the requested case passed.

## Component system rebuild

### COMP-V2-AUTHOR-001: Atomic master authoring

Create and replace a complete component definition through the file command boundary. Require a new definition to start at revision zero, advance replacements exactly once, preserve stable component and source identity, and bump the file revision once.

### COMP-V2-HISTORY-001: Checked component history

Undo and redo component authoring through semantic file commands. The inverse must compare the complete expected definition and reject a same-revision mutation instead of blindly restoring old state.

### COMP-V2-AUTHOR-NEG-001 and COMP-V2-AUTHOR-NEG-002: Closed and referenced masters

Reject unknown command fields, invalid revisions, stale edits, source-identity changes, and deletion of a definition while an instance still references it.

### COMP-V2-INSTANCE-002: Isolated instance values

Create and replace one instance through the file command boundary. Preserve the master and peer instances byte-for-byte, retain only explicit overrides, and resolve unset values from the current master defaults.

### COMP-V2-INSTANCE-HISTORY-001: Checked instance history

Undo and redo instance creation and replacement through semantic file commands. Reject an inverse when the complete expected instance no longer matches current state.

### COMP-V2-DOCS-001: Blume catalog

Generate one deterministic, versioned catalog from the validated component model. Include stable routes, navigation, playground controls and defaults, variant combinations, and an Open in canvas target. Include a usage snippet only when a source adapter supplies exact code.

### COMP-V2-DOCS-NEG-001: Honest docs output

Reject duplicate routes, usage for missing definitions, and empty usage snippets. Mark canvas-only components and unmapped code components unavailable instead of inventing source examples.

### COMP-V2-DOCS-002: Reviewed Blume source plan

Turn the validated component catalog into deterministic Blume MDX, exact example modules, navigation, and a serialized manifest without writing the repository. Include only components with both an exact usage snippet and an exact example-source adapter. Preserve supplied example source byte-for-byte, report unsupported components as omissions, and reject unknown identities, duplicate bindings, extended example paths, and traversal-like paths. Evidence: `packages/repo-engine/tests/component-docs-blume.test.ts`.

### COMP-V2-DOCS-003: Checked Blume source transaction

Prepare every generated documentation file through the reviewed source transaction without changing repository bytes. Preserve unrelated navigation pages through a TypeScript AST merge, require a documentation build validator, reject an incorrect approval digest, and invalidate the review when any included non-`src` source changes. Recheck the same hashes under the source lock before an atomic Save. Evidence: `packages/repo-engine/tests/engine.test.ts`.

### COMP-V2-DOCS-004: Explicit repository docs adapter

Require a versioned repository mapping for the Blume layout, verified component identity, public import specifier, and example path. Generate usage and example source only from the verified export and represented component defaults. Reject unknown fields, duplicate identities, duplicate routes, unsafe paths, URL imports, canvas-only definitions, and components absent from verified scanner evidence. Evidence: `packages/repo-engine/tests/component-docs-adapter.test.ts`.

### COMP-V2-DOCS-005: Hosted documentation review

Persist prepare and Save as separate leased states bound to the exact file revision, document hash, completed scan, repository grant generation, branch ref, base commit, base tree, adapter, planned files, validation evidence, and approval digest. Reviewers may prepare and inspect. Only an owner or editor with live contents-write permission may approve Save. No prepare transition writes repository bytes. Save creates one Git commit for the complete reviewed file set, records the proposed commit before advancing the branch, and resumes safely after a worker interruption. Evidence: `packages/repo-engine/tests/hosted-source-review.test.ts`, `packages/github-app/tests/docs.test.ts`, `packages/database/tests/migrations.test.ts`, `apps/repository-jobs/tests/docs-save-worker.test.ts`.

### COMP-V2-DOCS-NEG-002: Hosted review invalidation

Reject unsafe or duplicate paths, unvalidated bundles, unknown fields, non-branch refs, digest mismatches, stale file revisions, revoked grants, changed grant generations, changed reviewed bytes, and a branch that moved after review. Evidence: `packages/repo-engine/tests/hosted-source-review.test.ts`, `packages/github-app/tests/docs.test.ts`, `apps/repository-jobs/tests/docs-save-worker.test.ts`.

### COMP-V2-DOCS-006: Hosted Blume validation boundary

Validate reviewed documentation in a dedicated immutable image using the pinned Blume CLI, never repository package scripts. Require a server-owned dependency profile, fail before execution when the root manifest, Bun lockfile, docs manifest, design-system manifest, or consumed TypeScript configuration drifts, and run both `blume check --isolated --strict` and `blume build --isolated --strict`. The container has no network, a read-only source mount, no Linux capabilities, no privilege escalation, fixed CPU, memory, process, file-descriptor, output, and time limits, and no application secrets. Evidence: `apps/repository-jobs/tests/docs-sandbox.test.ts`, `scripts/test-hosted-docs-validator.mjs`.

### COMP-V2-DOCS-007: Explicit docs Save review

Show every reviewed file and exact diff in one compact repository-docs review dialog. Keep Save disabled until the user explicitly confirms the review. Preparing never opens or approves Save automatically. After approval, show the queued, saving, saved, stale, or failed server state and require a new review when the file revision, unsaved canvas input, or repository branch changes. Cancel an in-flight preparation when its exact file input changes. Reloading or opening the file after the project restores its latest authorized review, including the exact saved commit, without persisting approval state in the browser. Evidence: `packages/editor/src/features/editor/hosted-repository-service.test.ts`, `packages/editor/src/features/editor/ComponentKitPanel.client.test.ts`, `packages/database/tests/postgres-acceptance.mjs`.

### COMP-V2-ADMISSION-001: Verified code component admission

Authorize the exact project repository through the GitHub App, scan it with a named adapter, and admit one component from the verified registry. The integrity-bound registry carries exact required or optional evidence for every scalar prop. The resulting component definition uses the opaque persistent binding ID, exposes only representable properties and slots, and carries no mutable repository path, export name, source hash, installation ID, or credential. Evidence: `packages/scanner/tests/shadcn-scan.test.ts`, `packages/scanner/tests/artifact.test.ts`, `packages/repo-engine/tests/component-admission.test.ts`.

### COMP-V2-ADMISSION-NEG-001: Closed admission evidence

Reject stale source hashes or registry fingerprints, malformed or missing optionality evidence, extra repository-access fields, missing or invented defaults, numeric props without an explicit adapter, non-string enum values, unsupported source paths, and scanner evidence that no longer matches the reviewed binding. Evidence: `packages/preview-runtime/tests/verified-registry.test.ts`, `packages/repo-engine/tests/component-admission.test.ts`.

### COMP-V2-BINDING-001: Checked binding reconciliation

Move or rename a verified source component through an explicit rebind operation. Verify the path, export, source hash, and registry fingerprint update while the persistent binding ID remains unchanged. A same-shape request with stale expected evidence must fail.

### CLOUD-SYNC-LIFECYCLE-003: Admitted reconnect endurance

After a room has admitted the client, stop the sync server long enough to exceed the initial admission failure limit. Keep the last authoritative document visible, continue bounded reconnect attempts, then resync a restarted room without refreshing the page. The initial never-connected path must remain capped.

## Pull request interaction evidence

### PR-EVIDENCE-001: Deterministic planning

Map both sides of every changed path through the trusted capability registry. The same changes in any order produce identical canonical plans. Unmapped paths fail once with the complete sorted set. Visual capabilities without scenarios fail.

### PR-EVIDENCE-002: Strict manifest

Accept only the versioned manifest schema, safe relative paths, unique scenarios, unique assets, content hashes, exact run identity, and explicit nonvisual reasons. Reject unknown keys and unsafe paths.

### PR-EVIDENCE-003: Browser capture

Run the transient-move pilot through public automation actions and real pointer input. Capture before, held, and after screenshots plus a recording. Verify preview geometry, HUD geometry, committed state, and viewport stability independently. Default browser evidence ports are disjoint from the complete local service topology, while validated overrides keep parallel runs possible without stopping a healthy development service. Evidence: `tests/pr-evidence/ports.ts`, `tests/pr-evidence/ports.test.ts`, `tests/pr-evidence/playwright.config.ts`.

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

Draw a 500 by 500 frame through real pointer input, move it around a closed path, set its fill to red through the inspector, and add flex through the keyboard command. During every held move, verify that preview and HUD geometry agree while stored geometry remains unchanged. Keep the Add flex control mounted and visible throughout the gesture, disable it while pointer authority owns the node, and restore it immediately after release. After release, independently verify the stored size, fill, flex layout, screenshots, and recording.

### PR-EVIDENCE-011: Typed overlay and evidence crops

Create a frame through public automation actions. Verify typed overlay bounds, eight resize handles, four rotation handles, and stale-overlay rejection after deselection. Interrupt the existing preview connection and verify the last valid overlay stays mounted through the readiness gap, then reconnect the same preview and verify fresh geometry replaces the retained frame. Capture a two-times compositor screenshot and an independent poster with node-relative padding and the current theme background. Record the moving node from real compositor frames at two-times scale. Verify motion remains the default, compositor capture requires a bounded crop, and normalization preserves the already-composited dimensions.

### PR-EVIDENCE-012: Hosted login surface

Render the hosted login application in a real browser. Verify the exact brand and heading, disabled email and Google actions, enabled GitHub action, equal provider-button heights, and one ready-state screenshot.

### PR-EVIDENCE-013: Typography controls

Wait for the isolated preview handshake, create and commit text through real pointer and keyboard input, then open the font-family dialog. Verify the text inspector, focused search field, populated catalog list, screenshot, and recording. Create two borders and verify the Top and Bottom side labels fit without clipping.

### PR-EVIDENCE-014: Canvas component workflow

Create a canvas component from one selected frame through the public automation API and continue directly into that component's Kit details. Reject duplicate creation on the same master, author every property type, expose the component details and variant sheet, place one real instance, and verify the preview renders it. Change and reset an instance-only variant override, proving the projected appearance returns to the master default and the reset action clears. Author distinct Hover and Pressed appearances, then verify pointer hover, pointer down, pointer up, and pointer leave settle on the reviewed states without writing an instance override. Create one material, assign it to a second named part, clear that assignment, Undo it, capture the visible Materials and Parts controls, and verify both assignments survive reload. Generate and Undo a real canvas Variant sheet, edit and reload the component documentation identity, move the instance through pointer input, and independently verify that its stored transform changes while the master's transform remains unchanged. Exercise semantic deletion, detachment, and Undo before writing the capture report, so every declared screenshot exists in the final artifact. Capture Materials, component details, the placed instance, the generated Variant sheet, and a screen recording.

### PR-EVIDENCE-015: Theme color token editing

Create a color token through public automation actions. Open its color picker from the large visible preview, verify the nested picker remains inside the owning editor portal, close it with Escape, and verify focus returns to the preview. Edit opacity independently without opening the picker. Switch editor appearance, reopen the token, and verify the picker inherits the new mode. Capture light, opacity-edited, and dark states plus a recording. The client boundary separately verifies that the nested picker remains inside an owning mobile sheet.

### PR-EVIDENCE-016: Canvas text drop

Drop plain text through the public clipboard automation boundary. Reject a drop outside the canvas, accept the same payload at a canvas pointer, select exactly one new text node, and verify its preview text and rendered bounds independently match the requested pointer. Capture the resulting canvas state.

### PR-EVIDENCE-017: Mobile Properties menu

At 390 by 844, open the real Properties bottom sheet for a selected rectangle. Add a border, open its custom side menu, and verify the listbox is portaled inside the owning sheet. Escape closes only the menu and restores focus to its trigger. Reopen the menu, change Top to Bottom, verify the visible value, close the sheet, and capture the open and committed states plus a recording.

### PR-EVIDENCE-018: Stored font restoration

Create text, choose Geist from the real font picker, and verify the loaded face is transferred to the isolated preview. Reload the same file without reopening the picker. The stored family remains on the text node, a fresh matching face loads into the new preview document, and the rendered text still uses Geist. Capture the selected and restored states plus a recording with deterministic font responses.

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

In Layers, `Alt+ArrowUp` and `Alt+ArrowDown` reorder the selected subtree roots, `Alt+ArrowRight` moves them into the nearest legal preceding parent, and `Alt+ArrowLeft` moves them out one level. A same-parent multiselection moves as one ordered transaction. Each operation preserves node identity and world position and is reversible with undo and redo. Evidence: `packages/editor/src/features/editor/DocumentLayers.client.test.ts`, `packages/editor/src/features/editor/layer-tree-gesture.test.ts`, and `packages/editor/src/features/editor/document-store.test.ts`.

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

At 390 by 844, the canvas remains the primary surface. Layers and Properties open as mutually exclusive shadcn Base UI bottom sheets, stop at a useful partial height, preserve their real tree and inspector controls, trap focus, lock background scroll, and close by their close control, Escape, or an outside press. Read-only viewers can open Layers but cannot open Properties. Desktop rails and resize handles remain unchanged above the mobile breakpoint. Evidence: `tests/pr-evidence/scenarios/mobile-properties-menu.spec.ts`.

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

### AT-REPO-SCAN-001: Hosted repository scan boundary

Claim a queued scan through a dedicated repository-scan service credential and an atomic expiring lease. Recheck project membership, installation grant, and the exact repository before minting a read-only installation token. Keep that token inside the isolated worker. Resolve one immutable commit, accept its archive only through the exact HTTPS codeload repository and revision, enforce compressed, expanded, entry, file, path, type, and mode limits, and extract only into a worker-owned temporary directory. Run the static scanner without installing packages or executing repository code, and commit the validated scan result only while the lease and repository grant are still current. The client receives no token, filesystem path, or unverified source bytes.

Negative controls: two workers racing for one job, a stale lease, revoked membership, suspended installation, removed repository, wrong host or revision redirect, traversal path, symlink, submodule, duplicate path, oversized archive, expanded archive, entry set, or file, and unsupported mode must fail without publishing a scan result. The worker removes its temporary directory on success and failure.

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

Create, list, open, and save a blank file through the hosted API against PostgreSQL. Browser and Desktop must admit stored snapshots through the same canonical hosted-document validator. A structurally invalid stored snapshot terminates opening immediately with `Error ID: invalid-file-document`; it must not enter an endless reconnect loop. Verify the file summary and canonical document stay separate, revisions advance by compare-and-swap, and invalid identity, geometry, extra fields, stale revisions, signed-out access, and another account all fail without leaking file existence. Evidence: `packages/cloud-document/tests/hosted-document.test.ts`, `packages/sync-client/tests/collaboration-client.test.ts`, `apps/web/src/adapters/cloud.test.ts`, `apps/desktop/tests/cloud-files.test.ts`.

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

### FILE-OPEN-SLOW-001: Slow file opening and real failures

Open an owned or shared file while file listing, authorization, admission, or snapshot loading remains pending. After 15 seconds, verify the route still waits for the real result and shows `This is taking longer than usual.` with `Try again` and `Back to files`. Verify retry cancels and supersedes the active open before starting another attempt, back cancels the active open before returning home, and a late result from a superseded attempt cannot mutate the open document. When the adapter or collaboration lifecycle reports a real failure, verify the route renders the standard file error panel with a unique error ID.

Negative control: return a promise that never resolves from the file adapter and verify only the slow message appears, without manufacturing an error. Reject a separate adapter call and verify the resulting error includes a unique reference.

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

### DEV-SYNC-001: Current local room semantics

The local sync room executes its TypeScript source directly and watches its imported source dependency graph. Repo-engine command validation and hosted-catalog imports resolve to source, so a feature edit restarts the room with current semantics without rebuilding workspace `dist` trees or forcing editor Vite reloads. Evidence: `apps/sync-room-core/package.json`, `apps/sync-room-core/tsconfig.json`, `scripts/test-service-topology.mjs`.

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

Use observable engine events to verify the four-region shell, project opening, and preview lifecycle. Confirm startup and file opening use indeterminate progress unless measured totals exist, preserve the prior file until new metadata resolves, and display only phases whose work actually started. Trigger load failure, offline state, preview stop, crash, and invalid source. Confirm each known failure has one primary recovery action, invalid source retains the last good preview with current diagnostics, and closing the preview disposes owned resources. A transient hosted-auth outage keeps its error ID and one Try again action, retries the session without starting a new OAuth flow, and restores the requested file automatically when the auth service returns. Disposing or reconfiguring the auth adapter cancels stale recovery. Evidence: `apps/web/tests/file-open-startup.mjs`, `apps/web/src/shell/ApplicationDocument.test.ts`, `packages/editor/src/features/application/auth-service.test.ts`.

A cold direct file URL server-renders the themed `Opening file` shell before authentication or client hydration. With cache disabled, 150 ms latency, a throttled 200 KB/s connection, and every client script delayed 900 ms, the first paint remains opaque and themed, the loader stays centered with no measurable drift, and hydration never returns to a rootless frame. Capture this in light and dark appearances. Evidence: `outputs/file-open-startup-light`, `outputs/file-open-startup-dark`.

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

Create each supported token type in the Theme tab: color, opacity, radius, spacing, container, breakpoint, font family, font weight, font size, line height, and letter spacing. Edit and alias values only within the same type. Applicable numeric inspector fields expose compatible tokens through the themed, portaled menu instead of an invisible native select, and choosing one commits its resolved value. Bind a color token to nodes on two pages, change the value once, delete with inline replacement, and undo. Both pages resolve the same token id; the delete rewrites every solid fill, gradient stop, and alias across the file in one undoable step; scalar aliases retain their resolved literal; undo restores the token and the references. A second file has its own empty theme. Negative controls reject invalid domain values, cross-type aliases, and scalar tokens used as colors. Evidence: `document-architecture.mjs` checks 4, 5, 7; `file-document.test.ts` token cases; `document-store.test.ts` token creation cases; `packages/editor/src/design-system/inspector-atoms.client.test.ts`; `packages/editor/src/features/editor/layout-panels-flex.test.ts`.

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

The Theme token editor's visible color preview opens the color picker inside the owning editor or mobile-sheet portal. The opacity field remains a separate numeric editor. Evidence: `packages/editor/src/features/editor/ThemePanel.client.test.ts`, `tests/pr-evidence/scenarios/theme-token-color.spec.ts`.

### THEME-TOKEN-MENU-001: Safe token context actions

The token context menu exposes Cut, Copy, Paste, Paste over, Duplicate, Select all, ordered movement, and Delete in stable groups. Delete uses the same reference-aware path as the token editor: an unreferenced selection is removed directly, while referenced single or multi-token selections require confirmation and preserve the current resolved values at surviving reference sites. References between tokens in the same deletion are not presented as surviving references. Confirmation copy applies to every token type rather than describing all references as colors. Evidence: `packages/editor/src/features/editor/ThemePanel.client.test.ts`, `packages/repo-engine/tests/file-document.test.ts`.

### AT-APP-006: Image fill row

Choosing Image for a fill without cached image state selects the bundled `flowers.webp` asset at 1600 by 1200. The fill row shows a 42 by 32 thumbnail, filename, dimensions, and an `Edit` overlay on hover and keyboard focus. The thumbnail opens the image picker. No separate replace, intrinsic-size, or fit control is rendered.

### FILE-ASSET-002: Image format normalization

The picker accepts image inputs up to 25 MB. AVIF, PNG, JPEG, GIF, and WebP at or below the canonical 1,500,003-byte embedded preview limit keep their original bytes. HEIC and HEIF convert to JPEG at quality 0.92, including files identified by extension when the browser supplies an empty or generic MIME. Supported static images above the embedded limit and other browser-decodable image formats convert to bounded WebP before attachment. Animated GIF and WebP bytes are never silently flattened; an animation above the embedded limit adds no asset and surfaces the exact supported-type and limit error through the document toast channel. Invalid, deceptive, undecodable, and irreducible files also add no asset and surface their error through that channel.

### AT-APP-005: Component preservation and editor chrome

Imported components stay real React components with working props, slots, and Interact mode; appearance overrides apply to the existing root without wrappers and component-owned inline styles are restored when an override is removed; Canvas2D selection chrome stays visible with a document outline, follows transient move and resize geometry while the pointer remains held, and the preview keeps `renderChrome: false`. A collaborator selection on the same locally manipulated node uses that live geometry instead of leaving a stale outline at the saved position. Evidence: `packages/preview-runtime/tests/selection-electron.mjs`, `apps/web/tests/appearance.mjs`, `apps/web/tests/transient-move.mjs`, `packages/editor/src/features/collaboration/CollaborationPresence.test.ts`.

The last valid local selection HUD stays visible through a temporary preview readiness interruption only while file, page, selection, viewport, document revision, and layout generation remain unchanged. It retires on a real context or generation change, while geometry-backed writes and gestures stay unavailable until a fresh matching packet arrives. Evidence: `packages/editor/src/features/editor/canvas-hud-projection-service.test.ts`, `packages/editor/src/features/editor/scene-geometry.test.ts`, `packages/editor/src/features/editor/preview-asset-connection.test.ts`.

## Component model v2

### COMP-V2-PERSIST-001: Stored definitions and instances

A current file stores a validated component registry with definitions and isolated instance values. New and migrated files always contain the registry, instance defaults resolve without mutating their definition or peer instances, and the same data survives local, hosted, and collaboration persistence. Evidence: `packages/repo-engine/tests/component-model.test.ts`, `packages/repo-engine/tests/file-migration*.test.ts`, `packages/cloud-document/tests/hosted-document.test.ts`, `apps/web/src/features/files/service.test.ts`.

### COMP-V2-PERSIST-NEG-001: Closed persistence boundary

Reject unknown definition fields, invalid appearances, duplicate or missing identities, orphaned instances, mismatched definition ids, invalid overrides, and collections beyond their explicit limits. A malformed predecessor is not relabeled as current. Evidence: `packages/repo-engine/tests/component-model.test.ts`, `packages/repo-engine/tests/file-document.test.ts`.

### COMP-V2-PERSIST-ORPHAN-001: Historic orphan recovery

A current hosted document affected by the historic component deletion defect may remove only instance metadata whose design node is already absent. The complete repaired graph must validate, the source stays unchanged, the semantic revision does not advance, persistence requires an exact source match, and an active collaboration lease blocks repair. Other malformed graphs remain rejected. Evidence: `packages/cloud-document/tests/hosted-document.test.ts`, `apps/api/tests/legacy-assets.test.ts`, `packages/database/tests/control-plane.test.ts`, `packages/database/tests/postgres-acceptance.mjs`.

### COMP-V2-UI-001: Unified component kit

The left rail exposes one Kit view backed by the stored component model. It contains canvas masters and verified code components, and the retired Components section does not return. Evidence: `packages/editor/src/features/editor/Editor.test.ts`.

### COMP-V2-UI-002: Canvas master creation

Selecting one drawable layer can create one uniquely named canvas component master. The same layer cannot silently become two masters, and a placed instance or any of its linked descendants cannot become a second master without first removing its instance semantics. Open master selects the real source layer. Evidence: `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-003: Isolated instance editing

Placing an available component atomically creates its document node and model instance. Defaults project by source property name, editing stores a sparse override on only that instance, and undo restores the prior value. The inspector names instance controls separately from shared properties, shared materials, and shared layer assignments. It shows Reset only for an explicit override; Reset removes that sparse value and reprojects the master default. Evidence: `packages/editor/src/features/editor/document-store.test.ts`, `packages/editor/src/features/editor/ComponentModelProperties.client.test.ts`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`, `packages/repo-engine/tests/file-preview.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-004: Canvas instance placement

Placing a canvas component duplicates its real master subtree beside the source, creates one model instance with the duplicated root's persistent identity, selects it, and removes both records in one undo. Evidence: `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-005: Linked canvas instance content

Content, appearance, typography, sizing, visibility, and theme edits to a canvas master mirror into every structurally linked instance as one history transaction. Each instance root retains its own transform. Evidence: `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-006: Linked canvas instance structure

Inserting, duplicating, reordering, reparenting, and deleting nodes in a canvas master mirrors the same tree operation into every linked instance. Undo restores the master and every instance together. Evidence: `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-007: Component property authoring

Selecting a canvas master exposes one property authoring surface for Variant, Text, Boolean, and Slot definitions. New definitions begin on the first compatible named layer, and property types with no compatible layer are unavailable instead of creating inert schema. Definitions use stable ids, checked revisions, editable defaults and variant values. Removing a property or variant value atomically clears incompatible instance overrides and interactions, and Undo restores the complete valid graph. Evidence: `packages/editor/src/features/editor/document-store.test.ts`, `packages/editor/src/features/editor/ComponentMasterProperties.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-008: Bound instance properties

Text and Boolean properties bind to stable master-layer ids and project sparse values onto only the edited canvas instance. Master default edits update unoverridden peers while preserving explicit overrides. Slot properties bind to a host layer and accept instance-only text, frame, or another available component. Component slot insertion creates a real nested instance, excludes both direct self-nesting and every component identity already present in the owning instance chain, remains isolated from peer instances and the master, and is removed by one Undo. Invalid recursive choices are absent from the menu and rejected again at the command boundary. Evidence: `packages/editor/src/features/editor/document-store.test.ts`, `packages/editor/src/features/editor/ComponentModelProperties.client.test.ts`, `packages/repo-engine/tests/component-model.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-009: Variants, materials, and interactions

Variant properties capture appearance states on a bound layer, preserve per-instance values, and keep later state edits synchronized. A newly added option starts as an exact copy of the currently visible state and becomes the active editing state, so the next inspector change belongs to that option without an extra selection step. The compact property row shows only the property identity, bound layer, and active editing state; hover and press mappings stay in the property dialog instead of being truncated into the inspector card. A material definition can be assigned to multiple named component parts without moving it from an existing part. Capturing a material from one assigned part updates every other assigned master part and each linked instance part that is not explicitly controlled by a variant. Clearing one assignment preserves the material and the other assignments, and Undo restores it. Hover and press interactions project only their reviewed appearance and transition data into the isolated preview, run on the real canvas node in Interact mode, and remain inert in Select mode. Evidence: `packages/editor/src/features/editor/document-store.test.ts`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`, `packages/repo-engine/tests/file-preview.test.ts`, `packages/preview-runtime/tests/scene-protocol.test.ts`, `packages/preview-runtime/tests/component-interaction-browser-runtime.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-010: Component details, playground, and variant sheet

Opening a component from the Kit shows its shared property controls, source, usage availability, and deterministic variant combinations. The detail route survives background document reconciliation, and unsaved playground choices survive placement, Undo, and unrelated document revisions while removed values resolve safely against the latest definition. The playground places one configured instance and each variant-sheet row places that exact sparse combination on the canvas. Placement, projected canvas state, model record, selection, and undo are one transaction. Open in canvas returns to Design only after selecting the real master. Evidence: `packages/editor/src/features/editor/ComponentKitPanel.tsx`, `packages/editor/src/features/editor/component-kit-navigation.test.ts`, `packages/editor/src/features/editor/ComponentKitPanel.client.test.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `packages/repo-engine/tests/component-model.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-011: Browser component workflow

The evidence SDK drives the visible editor to create one canvas component with a real nested text layer, rejects a second master on the same layer, authors bound Variant, Text, Boolean, and Slot properties, wires hover and press interactions, and changes distinct Hover and Pressed appearances through the real inspector. It proves one instance can override and reset its variant, label, visibility, and slot content without changing the master, including Undo for Text and Boolean resets. The slot menu excludes direct and ancestor recursion, inserts another canvas component as a real nested instance, undoes that insertion, then persists ordinary frame content. Interact mode renders Hover on pointer entry, Pressed on pointer down, Hover on pointer up, and Default on pointer leave without writing an override. Component details survive background document updates, the Playground and variant sheet place exact sparse configurations, and the Instances list follows Place and Undo. Opening a listed use selects the real instance; duplicating it preserves component identity and sparse values, and Undo removes the copy. Page duplication creates a second semantic use and Undo removes it. Keyboard deletion removes a selected instance or master without leaving orphaned component data, and Undo restores both; the same key cannot delete a component-owned descendant inside an instance. Open in canvas returns to Design with the master selected. The scenario then moves the original instance without changing the master's stored transform, renames the definition, reloads the browser, verifies the same component ID, full property schema, interactions, sparse values, slot child, and preview node survive, removes a referenced variant value without leaving an invalid interaction, undoes that removal, and exercises reversible component removal. Evidence independently covers the stored component model, layer tree, isolated preview, screenshots, and recording. Evidence: `tests/pr-evidence/scenarios/component-system.spec.ts`, `packages/editor-automation/src/playwright.ts`.

### COMP-V2-UI-012: Component identity and direct authoring

A canvas master and every placed canvas instance render as Component elements in the layer tree, with the Component icon and shared component name even when their physical render node is a frame or primitive. Selecting an instance exposes its instance values and the same shared Properties and Materials authoring controls as its component master. The inspector does not reduce the instance to an origin link. Evidence: `packages/editor/src/features/editor/component-canvas-link.ts`, `packages/editor/src/features/editor/DocumentLayers.tsx`, `packages/editor/src/features/editor/Editor.test.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-013: Focused component definition authoring

The master inspector exposes the Variant currently being edited and per-part material assignments as compact selectors. The Variant dialog defines option names, the component default, and prototype mappings without duplicating the inspector's Editing control or silently switching appearances when an option is added. Material definitions stay separate from the Parts list, so one reusable material can be selected for multiple named layers. Creating or editing a Property, its Options, prototype transitions, or a Material happens in the editor's themed dialog and changes the model only after Save. Layer pickers expose only supported layer kinds with their real names and icons, and a second Variant property cannot bind to a layer whose full appearance is already owned by another Variant. Empty states stay empty instead of explaining the feature with instructional copy. Evidence: `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`, `packages/editor/src/features/editor/component-authoring-dialogs.test.ts`.

### COMP-V2-UI-014: Reversible component removal

Removing a canvas component clears its definition and every instance record in one checked transaction while preserving the master and placed layer trees as ordinary canvas content. Undo restores the definition, instance records, and component identities without recreating or replacing visual nodes. Evidence: `packages/editor/src/features/editor/document-store.test.ts`, `packages/editor/src/features/editor/ComponentKitPanel.tsx`.

### COMP-V2-UI-015: Stable component rename

Renaming a canvas component changes only its display name and revision. The persistent component ID, master binding, instance records, and layer identities remain unchanged, and Undo restores the prior name. Creation and rename reject case-insensitive duplicate names at both the visible form and command boundary so Kit actions and generated documentation remain unambiguous. Evidence: `packages/editor/src/features/editor/document-store.test.ts`, `packages/editor/src/features/editor/ComponentKitPanel.tsx`.

### COMP-V2-UI-016: Component uses

Component details list every live instance in real page order and number uses within each page. Opening a use switches to its owning page, selects the exact instance, and enters Design only after both operations succeed. Removed instances disappear from the list through the document model rather than a second usage index, and Undo restores them. Evidence: `packages/editor/src/features/editor/ComponentKitPanel.tsx`, `packages/editor/src/features/editor/ComponentKitPanel.client.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-017: Semantic component duplication

Duplicate, Alt-drag duplicate, layer-tree copy, outer-master placement, and canvas-component slot insertion copy every component-instance record whose physical node is in the copied subtree. The copy preserves stable definition identity and sparse instance values while receiving fresh node and instance IDs. Undo and Redo remove and restore the physical subtree and semantic records together. Evidence: `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-018: Semantic component deletion

Deleting a placed instance removes its physical subtree and component-instance record in one transaction. Deleting a canvas master, directly or with its owning page, removes its definition and every instance record while leaving placed physical subtrees elsewhere as ordinary canvas content. Undo restores the deleted master or page, definition, instance records, and component identities together. Evidence: `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-019: Bound master-layer deletion

Deleting a layer inside a canvas master removes the mirrored layer from every instance and removes properties, parts, interactions, sparse values, and nested component-instance records that referenced or lived inside the deleted branch. Unrelated materials, component definitions, and outer instance records remain intact. Undo restores the physical layers and semantic references together. File validation rejects a canvas definition whose source, property binding, or part points outside its master subtree. Evidence: `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `packages/repo-engine/src/file-document.ts`, `packages/repo-engine/tests/file-document.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-020: Linked instance structure protection

Delete, Duplicate, layer-tree move, direct reparent, canvas move, keyboard nudge, resize, and layout commands reject component-owned descendants inside a placed instance, preserving the shared master structure and history. The guard runs before linked-instance expansion, so legitimate master edits still mirror into protected descendants. The instance root remains movable and duplicable. Content inserted through a declared Slot remains independently editable and deletable, and Undo restores it. Evidence: `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-021: Slot property cleanup

Removing a Slot property through the component model or visible Edit property dialog removes every physical layer inserted through that Slot across all instances and removes nested component-instance records before their nodes. The property, content, and nested identities are one checked transaction, so Undo restores all of them together. Evidence: `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-022: Slot binding migration

Changing a canvas Slot property's bound layer moves the existing Slot content in every instance to the corresponding new host without replacing physical or nested component identities. The dialog and direct component command use the same migration planner. Undo restores the prior binding and moves the same content back. Evidence: `packages/editor/src/features/editor/component-property-projection.ts`, `packages/editor/src/features/editor/component-authoring-dialogs.tsx`, `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-023: Property removal reconciliation

Removing a bound Text, Boolean, or Variant property clears its sparse values and resets every canvas instance's affected layer to the master's real current text, visibility, or appearance. Undo restores the property, sparse value, and prior instance projection together. Evidence: `packages/editor/src/features/editor/component-property-projection.ts`, `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-024: Property binding migration

Changing a canvas Text, Boolean, or Variant property's bound layer resets the old layer in every instance from the master before projecting the existing sparse value onto the new layer. The visible dialog and direct component command use the same reset planner. Undo restores the old binding and both layers' prior projected state. Evidence: `packages/editor/src/features/editor/component-property-projection.ts`, `packages/editor/src/features/editor/component-authoring-dialogs.tsx`, `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-025: Nested component structural mirroring

Moving a live component instance into a canvas master mirrors its physical subtree and semantic instance record into every placed outer instance. Later nested instance-value changes mirror to each corresponding semantic record and physical layer. Undo removes the mirrored subtree and instance identity together. Evidence: `packages/editor/src/features/editor/component-canvas-link.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-026: Nested component duplication

Duplicating a nested component inside a canvas master creates a new semantic component-instance record for the master copy and each corresponding copy inside placed outer instances. Undo removes the duplicated physical subtrees and semantic records together while preserving the original nested uses. Evidence: `packages/editor/src/features/editor/component-canvas-link.ts`, `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-027: Nested instance override isolation

A component nested inside a placed canvas component remains a directly editable semantic instance. Changing one of its property values updates only that nested use and its physical layer, without mutating the nested source in the master or another outer instance. Editing the nested source in the master still mirrors its value to corresponding nested uses. Undo restores each scope independently. Evidence: `packages/editor/src/features/editor/component-canvas-link.ts`, `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-028: Nested component extraction

Moving a nested component out of a canvas master removes its mirrored physical subtree and every semantic instance record inside that subtree from each placed outer instance. The moved source remains a live component instance at its new location. Undo restores the original nesting, mirrored nodes, and semantic identities. Evidence: `packages/editor/src/features/editor/component-canvas-link.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-029: Multi-instance nested synchronization

Nested component adoption, source-value edits, duplication, extraction, and Undo apply to every placed outer instance. A property override made on one nested copy remains isolated from the nested source and sibling copies, while a source edit mirrors to all corresponding nested uses. Evidence: `packages/editor/src/features/editor/component-canvas-link.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-030: Recursive component validation

Persisted component definitions cannot contain themselves directly or through another canvas component. An acyclic nested chain remains valid. Direct and indirect recursive layer reparenting fail atomically in the editor. This independent file validator protects imports, collaboration snapshots, and stored documents even when the editor UI is bypassed. Evidence: `packages/repo-engine/src/file-document.ts`, `packages/repo-engine/tests/file-document.test.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-031: Nested component reorder parity

Reordering a nested component in a canvas master applies the same sibling order to every placed outer instance without replacing or changing any nested semantic instance record. Undo restores the prior order everywhere while preserving the same identities. Evidence: `packages/editor/src/features/editor/component-canvas-link.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-032: Deep component-tree synchronization

In an A containing B containing C tree, source appearance edits and property defaults reach every C use inside multiple placed A instances while sparse overrides remain isolated. Removing a property reconciles every deep use to the real master value. Removing C as a component clears every deep semantic record while preserving the physical canvas content, and Undo restores the exact semantic graph. Evidence: `packages/editor/src/features/editor/component-canvas-link.ts`, `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-033: Deep variant-reference cleanup

Removing a Variant value used by a deep component instance clears that sparse value, removes interactions targeting the deleted value, and projects the default appearance. Undo restores the value, interaction, and rendered state together. Evidence: `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-034: Nested material projection

Capturing a Material from one assigned part updates every other assigned part on the canvas master and every linked instance, including instances nested inside another canvas component. Undo restores the previous Material definition and every projected appearance without rolling back the source appearance edit that preceded the capture; a second Undo restores that source edit. Removing a Material clears its assignments without changing the rendered parts, and Undo restores the exact definition. Evidence: `packages/editor/src/features/editor/component-material-projection.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-035: Configured component preview projection

The component playground projects Variant, Text, and Boolean draft values into an isolated copy of the real canvas master subtree using the production preview document format. Unrelated page layers are absent, the master transform is normalized into a tight transparent frame, and the authoritative file remains byte-for-byte unchanged. The fitted camera centers that frame around the preview runtime's center-origin canvas with restrained padding. The preview uses a restrained transparency surface so white and transparent components remain visible without changing their rendered appearance. The playground remains in its loading state until the runtime acknowledges the exact sequenced document after its DOM render, surfaces runtime diagnostics as a concise retryable failure, and recovers through the same preview connection. Code components without a verified source adapter remain unavailable rather than receiving invented markup. Evidence: `packages/editor/src/features/editor/component-configured-preview.ts`, `packages/editor/src/features/editor/component-configured-preview.test.ts`, `packages/editor/src/features/editor/component-docs-preview-service.test.ts`, `packages/preview-runtime/tests/component-interaction-browser-runtime.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-036: Previewable variant combinations

Each generated variant combination is a selectable preview choice, not a blind placement action. Selecting a row updates the playground's variant controls and real configured-component preview in one batch while preserving non-variant drafts. A single Reset playground action returns every control and the preview to the current master defaults, then disappears. The adjacent placement action continues to place that exact sparse combination. Evidence: `packages/editor/src/features/editor/ComponentKitPanel.tsx`, `packages/editor/src/features/editor/component-docs-preview-service.ts`, `packages/editor/src/features/editor/ComponentKitPanel.client.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-037: Generated canvas variant sheet

A canvas-authored component's Variant sheet has one explicit Place sheet action. It creates one real linked instance for every generated Variant combination in a non-overlapping grid beside the master, stores only sparse values, projects each configured appearance, and labels every cell with the same concise property/value summary shown in the Kit. The selected transparent frame is named for the component's variants, giving the whole generated sheet one movable selection without decorative editor UI. The whole sheet is one document transaction, so one Undo removes every generated node, label, and semantic instance and one Redo restores them. Code components do not expose this action until a verified source adapter can provide equivalent canvas geometry. Evidence: `packages/repo-engine/src/component-model.ts`, `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `packages/editor/src/features/editor/ComponentKitPanel.tsx`, `packages/editor/src/features/editor/ComponentKitPanel.client.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-038: Contextual code-component properties

The semantic component inspector appears only when one reconciled code-component instance is selected. Reconciliation adopts existing verified code nodes without rewriting supported props, and unsupported source values remain read-only. Ordinary layers, generated variant-sheet frames, and multiple selections do not receive an irrelevant component empty state or instructional copy. Evidence: `packages/editor/src/features/editor/ComponentModelProperties.tsx`, `packages/editor/src/features/editor/ComponentModelProperties.client.test.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-039: Reversible canvas instance detachment

A selected canvas-component instance can detach into ordinary editable canvas layers without changing or replacing its physical subtree. Detachment removes only that outer instance record, preserves nested component instances as live semantic uses, and leaves code-component instances attached because their verified render identity cannot be converted into invented canvas primitives. One Undo restores the exact outer instance identity and values. Evidence: `packages/editor/src/features/editor/document-store.test.ts`, `packages/editor/src/features/editor/ComponentModelProperties.client.test.ts`.

### COMP-V2-UI-040: Direct main-component navigation

A selected canvas instance exposes a compact Open main component action beside its instance controls. The action selects the exact persisted master layer without changing the instance, its sparse values, or the current document. Code components do not expose a false canvas-master action. Evidence: `packages/editor/src/features/editor/ComponentModelProperties.client.test.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-041: Atomic reset of instance values

Every configured canvas or verified code instance exposes one compact Reset all instance properties action in addition to each precise per-property reset. Reset all removes every sparse scalar value and reprojects the real current defaults in one transaction; it does not touch Slot content. One Undo restores the exact sparse values and rendered state. The action is absent when the instance already uses every default. Evidence: `packages/editor/src/features/editor/document-store.test.ts`, `packages/editor/src/features/editor/ComponentModelProperties.client.test.ts`.

### COMP-V2-UI-042: Grouped component materials

The shared Materials inspector renders each authored material under its named group instead of flattening all definitions into one list. Each row concisely reports Not assigned or the number of controlled layers. Group order follows first appearance and material order inside each group follows the component definition, so editing metadata does not silently rearrange the component API. Part assignment menus expose the same groups. Evidence: `packages/editor/src/features/editor/ComponentMasterProperties.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-043: Recognizable component property types

The Add property menu pairs Variant, Text, Boolean, and Slot with their established editor icons while preserving unsupported-type disabling. Evidence: `packages/editor/src/features/editor/component-kit-copy.ts`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-044: Honest unbound property state

An imported or legacy component property without a layer binding is labeled Unbound in the inspector instead of presenting the implementation phrase Layer · No layer. Bound properties continue to show the real layer name. Evidence: `packages/editor/src/features/editor/ComponentMasterProperties.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-045: Persistent property type identity

Saved Variant, Text, Boolean, and Slot rows retain the same editor-native type icons used by the Add property menu without adding duplicate labels. Evidence: `packages/editor/src/design-system/component-kit-atoms.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-046: Stable material groups

New materials default to the component's first authored group. Saving a case-insensitive match reuses the established group spelling instead of creating a visually duplicate section, while a genuinely new group remains available. Evidence: `packages/editor/src/features/editor/component-authoring-dialogs.tsx`, `packages/editor/src/features/editor/component-authoring-dialogs.test.ts`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-047: Visible component usage

Each Kit row reports its source and live instance count in one muted line. Place, deletion, Undo, and other semantic instance changes update the count from the stored component model without a second usage index. Evidence: `packages/editor/src/features/editor/ComponentKitPanel.tsx`, `packages/editor/src/features/editor/ComponentKitPanel.client.test.ts`.

### COMP-V2-UI-048: Contextual component creation

Create component belongs to an eligible selected layer's context menu and opens the shared authoring dialog. Kit remains an inventory of existing components. Existing masters, placed instances, protected descendants, roots, empty selection, and multiple selection do not expose a dead action. Creation rechecks the live selection, rejects duplicate names before dispatch, and creates one semantic canvas definition without replacing the visual node. Evidence: `packages/editor/src/features/editor/component-creation-service.ts`, `packages/editor/src/features/editor/ComponentCreationDialog.tsx`, `packages/editor/src/features/editor/ComponentCreationDialog.client.test.ts`, `packages/editor/src/features/editor/NodeContextMenu.tsx`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-049: Honest unbound variant controls

An unbound Variant remains visible and editable through its definition dialog, but its compact Canvas edits selector is disabled until a real layer binding exists. The inspector does not offer a state change that cannot produce an appearance. Evidence: `packages/editor/src/features/editor/ComponentMasterProperties.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-050: Direct property binding action

Every unbound component property labels its repair action Bind and returns to Edit after a real layer binding exists. The same authoring dialog remains the single place that changes the definition. Evidence: `packages/editor/src/features/editor/ComponentMasterProperties.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-051: Consistent property binding flow

Opening an unbound property's Bind action presents a Bind property dialog with the supported layer picker already focused on a valid component layer. Cancel remains non-mutating and a saved binding returns the row to Edit. Evidence: `packages/editor/src/features/editor/component-authoring-dialogs.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-052: Undoable Variant binding

Saving Bind property on an existing unbound Variant captures the selected layer's current appearance for every authored value in one document transaction. The compact Canvas edits selector becomes usable immediately, and one Undo restores the unbound definition and Bind action without discarding the Variant values. Evidence: `packages/editor/src/features/editor/component-authoring-dialogs.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-053: Visible Variant edit target

A bound Variant row names both the layer receiving edits and the currently selected appearance. Changing the compact Canvas edits selector updates that message immediately, so state authoring is visible without opening a second dialog or adding instructional empty-state copy. Evidence: `packages/editor/src/features/editor/ComponentMasterProperties.tsx`, `packages/editor/src/features/editor/component-kit-copy.ts`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-054: Component identity in the inspector

Selecting either a canvas component master or one of its instances places the established component glyph beside the inspector title. Ordinary layers and pages keep the plain title, so the element's semantic type remains visible without a duplicate badge or explanatory section. Evidence: `packages/editor/src/features/editor/Editor.tsx`, `packages/editor/src/design-system/molecules.tsx`, `packages/editor/src/design-system/styles.css`, `packages/editor/src/features/editor/Editor.test.ts`.

### COMP-V2-UI-055: Explain unavailable property types

The Add property menu keeps the four supported property types visible, disables only types without a compatible component layer, and exposes the exact missing layer requirement as the disabled item's description and native tooltip. No permanent instruction block or failing toast is added. Evidence: `packages/editor/src/features/editor/ComponentMasterProperties.tsx`, `packages/editor/src/design-system/component-kit-atoms.tsx`, `packages/editor/src/features/editor/component-kit-copy.ts`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-056: Visible Variant options

Each authored Variant row reports its number of options beside the property type. The compact inspector therefore exposes the size of the component API without opening its dialog or adding instructional copy. Evidence: `packages/editor/src/features/editor/ComponentMasterProperties.tsx`, `packages/editor/src/features/editor/component-kit-copy.ts`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-057: Actionable instance properties

A canvas instance exposes controls only for properties bound to a real master layer. Unbound definitions remain repairable through Shared properties but do not create instance controls that store values without changing the canvas, or leave a Reset all action for hidden overrides. Verified code-component properties remain available without canvas bindings. Evidence: `packages/editor/src/features/editor/ComponentModelProperties.tsx`, `packages/editor/src/features/editor/ComponentModelProperties.client.test.ts`.

### COMP-V2-UI-058: Actionable component playground

The Kit playground and generated canvas Variant sheet include only properties bound to a real canvas layer. An unbound property remains authorable on the master but cannot create a no-op playground control, preview combination, configured value, or Variant-sheet instance. Verified code-component properties remain configurable through their source adapter. Evidence: `packages/editor/src/features/editor/component-property-projection.ts`, `packages/editor/src/features/editor/ComponentKitPanel.tsx`, `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/ComponentKitPanel.client.test.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-059: Bound-value command boundary

Canvas placement and instance-value commands reject a non-null value for an unbound property before writing document history. The same commands continue to accept bound canvas properties and verified code-component properties, while null remains available to clear a stale sparse value. Evidence: `packages/editor/src/features/editor/document-store.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### COMP-V2-UI-060: Honest property repair action

An unbound property says Bind only while a compatible, unclaimed layer is available. Without a valid target it remains editable as metadata through Edit property instead of opening a binding flow that cannot bind anything. Adding a compatible layer changes the same row to Bind without recreating the property. Evidence: `packages/editor/src/features/editor/ComponentMasterProperties.tsx`, `packages/editor/src/features/editor/component-authoring-dialogs.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-061: Authoritative inspector component identity

The inspector names and marks a selection as a Component only when the stored semantic component model identifies that exact node as a master or instance. An unreconciled code node keeps its real layer name and ordinary-node presentation instead of borrowing partial component identity from the preview snapshot or source atom catalog. Evidence: `packages/editor/src/features/editor/Editor.tsx`, `packages/editor/src/features/editor/Editor.test.ts`.

### COMP-V2-UI-062: Prepared source review only

The global source-review entry appears only when a real prepared transaction exists. Ctrl or Cmd plus S is not claimed by an empty review surface, and the shortcut list does not advertise it. A prepared transaction still opens the same reviewed Save boundary, while repository documentation review remains a separate explicit flow. Evidence: `packages/editor/src/features/editor/Editor.tsx`, `packages/editor/src/features/editor/keyboard-service.ts`, `packages/editor/src/features/editor/Editor.test.ts`, `packages/editor/src/features/editor/keyboard-service.test.ts`.

### COMP-V2-UI-063: Separate repository lifecycle

The Kit presents existing components as one stable inventory. Repository connection, scanning, preview, documentation review, and Save state live in a separate Sources tab with their own feature owner. Repository state cannot change the meaning or empty state of the component inventory. The existing reviewed docs transaction still requires exact diffs and explicit approval before Save. Evidence: `packages/editor/src/features/editor/ComponentKitPanel.tsx`, `packages/editor/src/features/editor/ComponentRepositoryPanel.tsx`, `packages/editor/src/features/editor/Editor.test.ts`, `packages/editor/src/features/editor/ComponentKitPanel.client.test.ts`, `packages/editor/src/features/editor/hosted-repository-service.test.ts`.

### COMP-V2-UI-064: Authored component documentation identity

A canvas component's details view edits its name and concise documentation description in one checked component transaction. The first documentation edit derives a unique stable route slug without exposing route plumbing in the interface; later renames preserve that slug. The saved description appears with the component identity and flows into the deterministic Blume manifest. Duplicate names are rejected before dispatch, Cancel is non-mutating, and one Undo restores the exact prior definition. Evidence: `packages/editor/src/features/editor/ComponentKitPanel.tsx`, `packages/editor/src/features/editor/ComponentKitPanel.client.test.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `packages/repo-engine/tests/component-model.test.ts`.

### CLOUD-SYNC-COMPONENT-001: Component authoring stays on one live authority

Creating a canvas component and replacing its authored Variant, Text, Boolean, Slot, Material, Part, Hover, and Pressed metadata use the existing semantic collaboration socket. Two real WebSocket clients converge on the complete definition, a placed instance with sparse overrides, and a nested component inside its slot. Exact mutation replay is idempotent; mutation-id reuse, stale component replacement, and stale instance history fail closed without advancing the persisted projection. A room and network restart reloads the same stable identities, instance values, nesting, master transform, and independent instance transform from persisted authority. Evidence: `apps/web/src/adapters/cloud.test.ts`, `apps/sync-room-core/tests/network.test.ts`, `packages/database/tests/collaboration-postgres-acceptance.mjs`.

### COMP-V2-CODE-001: Verified code component reconciliation

An active verified registry reconciles stable code-component definitions into the same model used by canvas components. The adapter exposes only string, Boolean, string-enum, and declared Slot properties it can represent exactly, including explicit optionality from the integrity-bound registry; numeric behavior is not invented. Placement creates the real verified component node, property changes project onto only that node, declared slots accept instance content, and a disconnected definition remains readable but unavailable. Evidence: `packages/editor/src/features/editor/component-registry.test.ts`, `packages/editor/src/features/editor/document-store.test.ts`, `packages/editor/src/features/editor/repository-service.test.ts`.

### COMP-V2-CODE-002: Hosted component discovery

A completed server-validated GitHub scan derives the same renderer-safe catalog used by local repository connections. Discovered definitions enter Kit with stable identities and exact representable properties and slots, but remain unavailable for placement until a verified hosted preview build binds their source. Refresh restores only the latest scan for the exact current repository grant; relinking or revocation cannot revive an older artifact. Rescans reconcile metadata without fabricating runtime support. Evidence: `packages/scanner/tests/component-catalog.test.ts`, `packages/github-app/tests/github-app.test.ts`, `apps/api/tests/app.test.ts`, `packages/cloud-client/tests/client.test.ts`, `apps/web/src/adapters/cloud.test.ts`, `packages/editor/src/features/editor/component-registry.test.ts`, `packages/editor/src/features/editor/hosted-repository-service.test.ts`.

### COMP-V2-CODE-003: Hosted preview artifact admission

A hosted preview artifact is accepted only when its exact source revision and canonical registry-request fingerprint agree, every declared component has one unique binding to a declared JavaScript module, the binding set exactly matches the requested catalog, and the complete immutable file set matches its declared paths, content types, byte lengths, and SHA-256 hashes. The trusted expectation is derived only from the server-validated scan artifact, including each integrity-bound component, style, dependency, provider, and theme adapter in its canonical request. Reject traversal, undeclared files, changed bytes, omitted components, duplicate identities, unsupported content types, and artifacts over the explicit count or byte limits before staging any bytes. A valid artifact is staged create-only under caller-persisted artifact and staging identities, then becomes visible through one atomic, idempotent storage-owned publication step. Failed staging and publication reconcile status before cleanup: continue the same attempt after a lost acknowledgement, discard only a confirmed-private receipt, preserve an already-published artifact, and leave an unknown attempt intact for later reconciliation. This contract does not execute repository scripts or replace the required operating-system sandbox for the external build worker. Evidence: `packages/scanner/tests/artifact.test.ts`, `packages/preview-runtime/tests/hosted-artifact.test.ts`.

### COMP-V2-CODE-004: Private hosted artifact storage

Store hosted preview files under a private, immutable staging identity and expose them only after one artifact state record changes from staged to published through an ETag compare-and-swap. Publication and discard race on that same record. A winning publication keeps every file; a winning discard tombstones the attempt before deleting its private files; a failed same-receipt retry must win that same discarded-state fence before cleanup and can never delete bytes another retry already published. A retry with the same persisted receipt is idempotent; another staging identity cannot replace an existing artifact. Resolve lost acknowledgements from stored state, rehash staged and served bytes, reject corrupt state, metadata, or bodies, and never serve staged or discarded bytes. Evidence: `packages/files/tests/hosted-preview-artifact.test.ts`, `packages/files/tests/file-assets-worker.test.ts`.

### COMP-V2-CODE-005: Internal hosted artifact read boundary

The file-assets Worker exposes an exact hosted artifact file only after its state is published and its stored metadata, byte length, and SHA-256 have been verified. The route accepts only GET and HEAD from an internal caller presenting the constant-time checked service token. It rejects browser Origin headers, does not emit CORS access, rejects encoded or traversal-like paths, and returns private no-store, nosniff, same-origin responses with the declared content type, length, and digest ETag. Staged, discarded, missing, and corrupt files are never returned. Evidence: `packages/files/tests/file-assets-worker.test.ts`, `apps/workers/src/index.ts`.

### COMP-V2-CODE-006: Isolated hosted preview gateway

The browser receives a short-lived HMAC capability bound to one artifact ID and one dedicated hosted-preview origin. Grants expire within five minutes, reject alternate encodings and signature changes, and cannot be replayed for another artifact or origin. The gateway accepts only a canonical capability-prefixed GET or HEAD path, follows no upstream redirects, validates the internal service response identity and digest headers, and never forwards its broad service credential to the browser. Every artifact response is private and no-store with no CORS, no referrer, nosniff, same-origin resource policy, a restrictive permissions policy, and an execution CSP that permits only same-origin scripts and styles while blocking network connections, forms, objects, workers, nested frames, and every frame ancestor except the configured editor origins. Application error logs redact the capability. Evidence: `packages/preview-runtime/tests/hosted-capability.test.ts`, `apps/preview/hosted-gateway.test.ts`, `apps/preview/hosted-gateway.ts`, `apps/preview/api/hosted/[...path].ts`.

### COMP-V2-CODE-007: Authorized hosted preview grants

A trusted publisher binds each immutable artifact ID to one exact file and current file revision before any browser capability can be issued. Registration is service-authenticated, create-only, idempotent only for the exact same metadata, and rejects stale file revisions or attempts to rebind an artifact identity. A signed-in owner or current viewer can request a short-lived capability only for an artifact bound to that file's current revision. Private cross-user requests, stale artifacts, mismatched file and artifact identities, and missing configuration are masked or rejected before signing. Evidence: `packages/database/migrations/0017_hosted_preview_artifacts.sql`, `packages/database/tests/migrations.test.ts`, `apps/api/tests/app.test.ts`.

### COMP-V2-CODE-008: Ephemeral hosted preview client boundary

The browser starts and polls a hosted build only for the currently open file. It requests a hosted preview only after that exact job completes with one server-owned artifact ID. It accepts only the configured isolated preview origin and the exact canonical capability path for that artifact, with no credentials, query, fragment, redirect, or traversal-like path. A response that arrives after a file switch or adapter disposal is rejected. The returned capability remains session-only and is never serialized into the file, repository scan, editor snapshot, or adapter state. The Kit presents the result as a repository preview without claiming the component is placeable. Hosted scans use the same canonical registry-request fingerprint as artifact admission, and discovered components remain unavailable until composition binding is separately verified. Evidence: `packages/cloud-client/tests/client.test.ts`, `apps/web/src/adapters/cloud.test.ts`, `packages/editor/src/features/editor/component-registry.test.ts`, `packages/editor/src/features/editor/hosted-repository-service.test.ts`.

### COMP-V2-CODE-009: Hosted build publication ordering

The build orchestrator validates the file, revision, artifact, staging, and scan identities before invoking the sandbox. The sandbox receives only the repository root and a canonical, deeply frozen build contract, never a GitHub installation token or service credential. Its complete output must pass the canonical scan-derived artifact admission and byte verification before private staging, atomic publication, and exact file-revision registration, in that order. Mismatched output never reaches storage or registration. A retry after an uncertain registration result must reuse the persisted artifact and staging IDs; published artifacts that never register require a separate retention and garbage-collection policy. This contract does not implement or weaken the required operating-system sandbox. Evidence: `apps/repository-jobs/tests/hosted-build.test.ts`, `packages/scanner/tests/artifact.test.ts`, `packages/preview-runtime/tests/hosted-artifact.test.ts`.

### COMP-V2-CODE-010: Hosted build operating-system boundary

The hosted builder launches only an immutable digest-pinned image under a fixed non-root identity. The repository is mounted read-only, writable output and temporary storage use size-limited in-container filesystems, networking is disabled, the root filesystem is read-only, Linux capabilities are dropped, privilege escalation is disabled, and process, memory, CPU, and time limits are explicit. The container receives only the canonical build contract through attached standard input plus fixed `HOME` and `CI` values; GitHub and service credentials are never forwarded. The host Docker client receives only `PATH`. Before bundling, the scanner pins the complete local import closure. The builder reads each declared source once, verifies its digest, and serves esbuild only those cached bytes; undeclared local imports and mutations after scanning fail closed. The builder returns one byte-limited JSON envelope through standard output instead of a writable host mount. The host drains the process pipes, then rejects malformed, duplicate, undeclared, oversized, or hash-mismatched files through the canonical artifact manifest and byte verification before publication admission. Timeout, input failure, and output overflow stop and await the Docker client, then force-remove the caller-named container before rejecting. The turnkey acceptance command builds the image, captures its immutable ID, and exercises real Chromium behavior plus changed-source and undeclared-import negative controls. Evidence: `apps/repository-jobs/tests/hosted-sandbox.test.ts`, `apps/repository-jobs/tests/hosted-builder.integration.test.ts`, `packages/scanner/tests/shadcn-scan.test.ts`, `apps/repository-jobs/src/hosted-sandbox.ts`, `infra/hosted-preview-builder/build.mjs`, `scripts/test-hosted-preview-builder.mjs`.

### COMP-V2-CODE-011: File-scoped hosted build queue

Starting a hosted preview build accepts no client-selected repository, scan, revision, artifact, staging, or lease identity. The server derives the current file revision and project, authorizes the latest completed scan against the current GitHub grant, generates every build identity, and creates at most one job for that file revision and scan. Internal claims use an expiring lease, recheck the completed scan against the live installation and repository grant before minting a read-only token, and return that token only to the authenticated build worker. Revoked grants fail the leased job before source access. Completion, retry, and failure require the exact current lease; only a completed owner-visible job reveals its artifact identity. Evidence: `apps/api/tests/app.test.ts`, `packages/database/tests/migrations.test.ts`, `packages/github-app/tests/github-app.test.ts`.

### COMP-V2-CODE-012: Capability-bound hosted artifact writes

After an authorized build claim, the API issues one short-lived write capability bound to the exact job, current lease, server-owned artifact, server-owned staging identity, and configured assets origin. The assets worker accepts that capability only on private no-Origin internal routes. Each file write is individually byte-bounded, path-checked, content-type-checked, and digest-checked against the canonical artifact metadata; staging is create-only and idempotent only for identical bytes. Commit verifies the complete stored file set against the canonical manifest before the artifact can be published. Status, publication, and discard remain bound to the same receipt. The build transport sends no GitHub token, browser credential, cookie, broad service token, or caller-selected receipt to storage. Wrong, expired, or cross-artifact capabilities and incomplete or changed files fail without making an artifact visible. Evidence: `packages/preview-runtime/tests/hosted-write-capability.test.ts`, `packages/files/tests/file-assets-worker.test.ts`, `packages/files/tests/hosted-preview-artifact.test.ts`, `apps/repository-jobs/tests/hosted-build.test.ts`, `apps/api/tests/app.test.ts`.

### COMP-V2-UI-NEG-001: Honest unavailable states

The editor refuses to place an unavailable code component or a canvas master whose source subtree is missing. It does not insert a static substitute. Evidence: `packages/editor/src/features/editor/document-store.test.ts`.

## Font family picker

### FONT-CATALOG-001: Background catalog

The editor starts with system and already loaded families, then adds a catalog generated from official Google metadata asynchronously without blocking workspace startup. The catalog contains family, style, weight, and variable-axis metadata and is emitted as a separate production chunk. Choosing a Google family fetches and verifies the requested face in the background, caches it for the workspace session, and transfers bounded font data through the isolated preview protocol. Evidence: `packages/editor/src/features/fonts/font-catalog-service.test.ts`, `packages/preview-runtime/tests/protocol.test.ts`, `pnpm sync:fonts`, `pnpm --filter @canvas/web build`.

### FONT-LOCAL-001: Local font discovery

Workspace startup checks permission without prompting. A granted permission enumerates in the background. Prompt state requests access only from the picker gesture. The five-second loading deadline changes the UI state but does not discard a late successful result. Disposal cancels ownership and visibility retries. Electron grants only `local-fonts` from the trusted editor main frame and denies every other permission. Evidence: `packages/editor/src/features/fonts/font-catalog-service.test.ts`, `apps/desktop/tests/font-permission.test.ts`.

### FONT-CACHE-001: Session catalog ownership

Closing and reopening the picker does not rebuild the catalog. Favorites and discovered families remain in the workspace service until disposal, and normalized favorites persist for the browser profile. Evidence: `packages/editor/src/features/fonts/font-catalog-service.test.ts`.

### FONT-RESTORE-001: Stored document font restoration

Opening or refreshing a file automatically resolves every stored Google font after the background catalog arrives, then transfers the verified faces to the isolated preview before measurement. The user does not need to reopen the picker. Evidence: `packages/editor/src/features/fonts/font-catalog-service.test.ts`, `packages/editor/src/features/editor/preview-service.ts`.

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

## Transform matrix layout

### MATRIX-LAYOUT-001: Canonical persisted transform

Schema 12 stores each primitive pose only as `relativeTransform: [a, b, c, d, tx, ty]`. Width, height, and overflow remain separate size and clipping data. The current schema rejects legacy pose fields and malformed, non-finite, or singular matrices. Evidence: `packages/repo-engine/tests/file-transform-matrix.test.ts`, `packages/repo-engine/tests/transform-matrix.test.ts`, `packages/repo-engine/tests/file-document.test.ts`.

### MATRIX-LAYOUT-002: Nested composition and reparenting

World geometry composes parent and child matrices in parent-to-child order. Reparenting with world-position preservation writes the inverse target-parent composition without changing the visible world transform. Evidence: `packages/repo-engine/tests/file-transform-matrix.test.ts`, `packages/editor/src/features/editor/canvas-scene.test.ts`.

### MATRIX-LAYOUT-003: Inverse geometry

Hit testing maps world points through the inverse world matrix into local width and height bounds. Rotated frame corners outside the rendered face do not hit merely because they are inside its world AABB. Evidence: `packages/repo-engine/tests/file-transform-matrix.test.ts`, `packages/editor/src/features/editor/canvas-scene.test.ts`.

### MATRIX-LAYOUT-004: Legacy visual parity

Opening a schema 10 file converts primitive left, top, rotation, and reflections into one matrix around the same center without changing rendered bounds. Evidence: `packages/repo-engine/tests/file-migration.test.ts`, `packages/preview-runtime/tests/layout-pose-runtime.test.ts`.

### MATRIX-LAYOUT-005: Resize and scale remain distinct

Resize changes width and height while preserving the transform matrix. Matrix scale and skew remain transform operations and are not silently rewritten as size. Evidence: `packages/repo-engine/tests/file-transform-matrix.test.ts`, `packages/editor/src/features/editor/gesture-resize-command-planner.test.ts`.

### MATRIX-LAYOUT-006: Lossless affine authoring boundary

Canonical decomposition and composition round trip translation, rotation, non-uniform scale, reflection, and skew without changing point mapping. Evidence: `packages/repo-engine/tests/transform-matrix.test.ts`.

### MATRIX-LAYOUT-007: Lossless primitive inspector edits

Editing X or Y moves the rendered bounds without changing the matrix linear terms. Editing rotation or applying a quarter turn preserves the rendered center, non-uniform scale, reflection, and skew while setting the requested canonical rotation. The negative control proves the former local post-rotation shortcut does not set the requested rotation under skew and non-uniform scale. Evidence: `packages/editor/src/features/editor/matrix-style.test.ts`.

### MATRIX-LAYOUT-008: Affine resize projection

Resize maps pointer deltas through the inverse of the node's complete affine matrix. Scale and skew remain part of the immutable gesture authority, the opposite visual anchor stays fixed, and singular matrices fail closed. Evidence: `packages/editor/src/features/editor/canvas-math.test.ts`, `packages/editor/src/features/editor/layout-measure-resize.test.ts`, `packages/editor/src/features/editor/resize-projection.test.ts`.

### MATRIX-LAYOUT-009: Unified affine rotation preview

Rotation replaces only the canonical rotation component while preserving scale, reflection, and skew, then previews through the same strict matrix presentation used by resize. The runtime owns `transform` and `transform-origin` from protocol v9; the removed rotation-delta compatibility channel is rejected. Evidence: `packages/editor/src/features/editor/rotation-projection.test.ts`, `packages/editor/src/features/editor/canvas-gestures.test.ts`, `packages/preview-runtime/tests/protocol-negative-controls.test.ts`, `packages/preview-runtime/tests/transient-move-layer.test.ts`.

### MATRIX-LAYOUT-010: Component affine authority

Schema 12 stores a component root transform as one invertible linear affine matrix. Rotation, reflection, skew, and non-uniform scale survive inspector edits and cross-parent reparenting. Schema 11 component rotation and scale records migrate to the equivalent matrix, and collaboration cold-start admission upgrades schema 11 before validation. Evidence: `packages/repo-engine/tests/file-migration.test.ts`, `packages/editor/src/features/editor/layout-commands.test.ts`, `packages/editor/src/features/editor/layout-pose.test.ts`, `apps/sync-room-core/tests/legacy-document.test.ts`.

### MATRIX-LAYOUT-011: Matrix-only runtime and source boundary

The editor projects component transforms as a bounded linear CSS matrix with zero translation. The preview runtime and source-writing grammar accept that representation and reject legacy rotate or scale functions, translated matrices, hostile CSS, and coefficients outside the persisted transform bounds. Evidence: `packages/repo-engine/tests/layout.test.ts`, `packages/repo-engine/tests/promotion-layout.test.ts`, `packages/preview-runtime/tests/protocol-negative-controls.test.ts`, `packages/preview-runtime/tests/layout-pose-runtime.test.ts`.

### MATRIX-LAYOUT-HISTORY-001: Atomic transform history

Transform edits are one semantic command. Undo restores the exact prior serialized bytes and redo restores the exact transformed styles. Evidence: `packages/repo-engine/tests/file-transform-matrix.test.ts`, `packages/editor/src/features/editor/document-store.test.ts`.

### MATRIX-COLLAB-001: Collaboration and persistence round trip

Current schema 12 matrices survive hosted persistence, collaboration snapshots, reconnect replay, and desktop or web cache boundaries. Schemas 6 through 11 are admitted only through the explicit migration path. Evidence: `packages/cloud-document/tests/hosted-document.test.ts`, `packages/database/tests/collaboration-persistence.test.ts`, `apps/sync-room-core/tests/legacy-document.test.ts`, `packages/sync-client/tests/collaboration-client.test.ts`.

### COMP-V2-UI-065: Property descriptions stay with the component API

A canvas component property can carry a concise description authored in the same New property or Edit property dialog as its name and type. Saving, reload, and Undo preserve the description. Component details show it beside the matching playground control, and the same text appears in the generated Blume property reference without adding permanent instruction copy to the master inspector. Evidence: `packages/editor/src/features/editor/component-authoring-dialogs.tsx`, `packages/editor/src/features/editor/ComponentKitPanel.tsx`, `packages/repo-engine/src/component-model.ts`, `packages/repo-engine/src/component-docs-blume.ts`.

### COMP-V2-UI-066: Instance controls retain property intent

When a component property has a description, the selected instance shows that same concise text directly below the matching control. Properties without descriptions keep the compact existing layout, so the inspector does not gain an empty state or permanent instruction block. Evidence: `packages/editor/src/features/editor/ComponentModelProperties.tsx`, `packages/editor/src/design-system/component-kit-atoms.tsx`, `packages/editor/src/features/editor/ComponentModelProperties.client.test.ts`.

### COMP-V2-UI-067: Description inputs respect the persistence boundary

Component, property, and material description fields share the exact model limit and prevent longer input before Save. The validator independently rejects serialized descriptions beyond that limit, so normal authoring cannot degrade into a generic invalid-operation failure. Evidence: `packages/repo-engine/src/component-model.ts`, `packages/editor/src/design-system/property-atoms.tsx`, `packages/editor/src/features/editor/component-authoring-dialogs.tsx`, `packages/editor/src/features/editor/ComponentKitPanel.tsx`.

### COMP-V2-CODE-013: Optional code props preserve the component default

Verified optional string, boolean, enum, and Slot props enter the shared component model instead of disappearing. The hosted builder accepts the scanner's required optional marker and omits optional props from its initial render so the React component keeps its source default. An untouched instance likewise omits those props from the runtime node and labels the control Component default. Choosing a value writes an explicit instance override; resetting it removes the prop so the React component owns its default again. Canvas-authored properties cannot claim optional source semantics. Evidence: `infra/hosted-preview-builder/contract.mjs`, `apps/repository-jobs/tests/hosted-builder-contract.test.ts`, `packages/editor/src/features/editor/component-registry.ts`, `packages/editor/src/features/editor/component-property-projection.ts`, `packages/editor/src/features/editor/ComponentModelProperties.tsx`, `packages/repo-engine/src/component-model.ts`.

### COMP-V2-UI-068: Component edit scope is an action

An instance with editable component properties exposes a compact Edit scope control instead of permanent explanatory copy. Instance is selected by default and preserves sparse per-instance overrides. Shared property, material, and part authoring controls are not mounted beneath the instance controls. For a canvas-authored component, choosing Shared component opens the real master and its authoring controls. A code component exposes only Instance until a verified source adapter can prepare a reviewed shared-component patch. Evidence: `packages/editor/src/features/editor/Editor.tsx`, `packages/editor/src/features/editor/ComponentModelProperties.tsx`, `packages/editor/src/features/editor/ComponentModelProperties.client.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-069: Variant definition and appearance editing are separate

The property dialog owns the Variant schema: option names, the component default, and prototype mappings. Adding an option does not change the appearance being edited. The compact Canvas edits selector in the master inspector is the single control that changes the current authored appearance, and the row names that appearance directly. Removing the current option falls back to the component default when it still exists. Evidence: `packages/editor/src/features/editor/component-authoring-dialogs.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`, `tests/pr-evidence/scenarios/component-system.spec.ts`.

### COMP-V2-UI-070: Material capture follows the selected source

Choosing an Appearance source in the material dialog immediately captures that named layer into the unsaved material draft. Save applies the captured appearance to every assigned layer; Cancel leaves the material and canvas unchanged. An existing source can be sampled again through the explicit Use current appearance action. Evidence: `packages/editor/src/features/editor/component-authoring-dialogs.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-071: Property rebinding captures the selected layer

Choosing a different layer while editing a canvas Text or Boolean property updates the unsaved component default from that layer before Save. Saving moves the binding and its default together instead of applying a stale value from the previous layer. Cancel leaves the property and canvas unchanged. Variant rebinding follows the same rule through its captured appearance map. Evidence: `packages/editor/src/features/editor/component-authoring-dialogs.tsx`, `packages/editor/src/features/editor/ComponentMasterProperties.client.test.ts`.

### COMP-V2-UI-072: Component creation continues into its Kit details

After Create component succeeds, the editor opens that exact file-scoped component in Kit under a semantic component heading. The canvas selection and master inspector remain authoritative, while Kit immediately exposes placement, details, playground, instances, and Variant-sheet actions as they become available. A later manual sidebar choice wins until another explicit component navigation request, and a stale request from another file cannot change the active view. Evidence: `packages/editor/src/features/editor/ComponentCreationDialog.tsx`, `packages/editor/src/features/editor/ComponentCreationDialog.client.test.ts`, `packages/editor/src/features/editor/component-kit-navigation.ts`, `packages/editor/src/features/editor/component-kit-navigation.test.ts`, `packages/editor/src/features/editor/Editor.tsx`, `packages/editor/src/design-system/component-kit-atoms.tsx`.
