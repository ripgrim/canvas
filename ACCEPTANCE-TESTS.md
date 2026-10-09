# Acceptance tests

These tests define release evidence. A result is valid only when it uses real fixtures and observable boundaries. Mock-only demonstrations, skipped tests, and assertions derived from production logic do not pass.

## Evidence rules

- Record fixture revision, platform, tool versions, and relevant hashes.
- Compare against independently written expected values or checked fixture bytes.
- Critical tests include a negative control or targeted mutation that must fail.
- Keep screenshots, recordings, diffs, and diagnostics with the test result.
- Label unsupported adapters as unsupported. Do not rerun against a different adapter and claim the requested case passed.

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

### AT-CAN-002: Layout and snap

Verify fixed, fit, fill, min and max constraints, padding, gap, direction, alignment, wrap, absolute position, clipping, snap guides, align, distribute, nudge, large nudge, and frame resize.

### AT-CAN-003: Content types

Verify editable text, images, SVG vectors, borders, radius, shadows, opacity, filters, assets, and supported effects. Unsupported rich text and dynamic styling must show explicit limitations.

### AT-CAN-004: Zoom and history

Verify pan, zoom, actual size, fit all, fit selection, command search, undo, and redo on Windows and macOS keymaps. Use menus to prove keyboard-only alternatives exist.

### AT-CAN-005: Pointer and keyboard input

Verify mouse, touchpad, pointer capture, and keyboard-only manipulation. Dragging must not trap focus or prevent cancellation.

## Auth and authorization

### AT-AUTH-001: Better Auth desktop round trip

1. Request sign-in through the narrow preload API and confirm the Electron main process uses its Better Auth client to open the system browser.
2. Confirm the system browser opens the hosted flow.
3. Complete auth and return through a registered application link using PKCE and state.
4. Confirm main validates state and exchanges the one-time result.
5. Confirm the renderer receives only required session display data, with no token, cookie, or auth client.
6. Inspect the configured storage behavior and document its protection properties; do not assume encryption.
7. Restart the renderer and verify the main-held session remains usable.

Negative controls: replay the callback, alter state, use an unregistered scheme, and deliver the link to an unexpected window. Each must fail.

### AT-AUTH-002: Object authorization

Call project, repository, share, and sync APIs directly as Owner, Editor, Reviewer, Viewer, unrelated authenticated user, and signed-out user. Verify the permission matrix server-side.

Negative control: bypass the UI guard and call the API. Unauthorized access must still fail.

### AT-AUTH-003: Revocation

Revoke a member and a share link. Verify later HTTP requests and active subscriptions lose access. Confirm revoked state is shown without leaking project content.

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

## Copy and accessibility

### AT-UX-001: Action naming

Audit menus, shortcuts, command search, dialogs, and toasts. One action uses one label. Copy is sentence case, has no em dashes, and gives a recovery action for known failures.

### AT-UX-002: Accessible operation

Complete project opening, component insertion, selection, prop editing, review, Save, conflict resolution, and promotion using keyboard and a screen reader. Check focus order, names, roles, live regions, contrast, zoom, and reduced motion.

### AT-UX-003: Shell, loading, and recovery states

Use observable engine events to verify the four-region shell, project opening, and preview lifecycle. Confirm startup and file opening use indeterminate progress unless measured totals exist, preserve the prior file until new metadata resolves, and display only phases whose work actually started. Trigger load failure, offline state, preview stop, crash, and invalid source. Confirm each known failure has one primary recovery action, invalid source retains the last good preview with current diagnostics, and closing the preview disposes owned resources.

Visual review fixture: compare shell geometry and hierarchy against the supplied authorized Wonder/Paper reference evidence, including file bar, left rail, canvas/tool strip/zoom controls, and right inspector. Match only verified details; record unknown startup, autosave, conflict, and GitHub writeback behaviors as unknown rather than asserting parity. This is a design review criterion and must include screenshots plus the tested viewport and platform.

### AT-UX-004: Share access behavior

Open Share and verify it changes no permissions. Copy a link and verify it changes no permissions. Change link visibility and verify the consequence is stated before commit, public access requires confirmation, and the hosted service confirms the resulting state. Verify invite failure preserves entered recipients and role. Test local-only sharing consent against the exact listed upload set.

## Performance

### AT-PERF-001: Interaction budgets

Measure shell startup, selection, drag, inspector update, incremental preview build, and indexing phase response against `PRODUCT-SPEC.md`. Record hardware, release build, fixture size, warm or cold state, sample count, median, and p95.

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

### AT-APP-004: Inspector states and transitions

Eligibility follows the matrix (Text has no Outline or Border); absent, hidden, and removed are distinct; `+` follows the exact Fill, Outline, and Border sequences; mixed values show a mixed state and a replace action that changes every eligible node in one batch; type switching restores cached state; a multi-node edit is one undo step; gradient and reorder drags commit once and Escape restores with no history. Evidence: `appearance-adapters.test.ts`, `document-store.test.ts`, `apps/web/tests/appearance.mjs`.

### AT-APP-005: Component preservation and editor chrome

Imported components stay real React components with working props, slots, and Interact mode; appearance overrides apply to the existing root without wrappers and component-owned inline styles are restored when an override is removed; Canvas2D selection chrome stays visible with a document outline and the preview keeps `renderChrome: false`. Evidence: `packages/preview-runtime/tests/selection-electron.mjs`, `apps/web/tests/appearance.mjs`.
