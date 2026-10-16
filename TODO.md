# Todo

This list tracks the next product work in priority order. Product behavior and release evidence remain governed by `PRODUCT-SPEC.md` and `ACCEPTANCE-TESTS.md`.

## Now: two-way repository sync

- [x] Add the first read-only shadcn scanner to the isolated repository process.
  - Discover nested `components.json` files, configured UI roots, local registry roots, and canonical global stylesheets.
  - Parse real function, variable, `forwardRef`, and `memo` TSX exports without running package hooks or repository scripts.
  - Parse CSS custom properties with PostCSS and retain selector, theme, at-rule, alias, path, and source-location evidence.
  - Expose scans through validated preload IPC and the Repository inspector panel.
- [x] Add reusable repository connection foundations under `packages/repository`.
  - Choose an existing local Git repository through the desktop folder picker.
  - Clone a public GitHub repository into the managed `workspace/<repository-id>/repo` layout.
  - Keep canonical paths in the main process and expose only an opaque repository id, display name, scan results, and source kind.
  - Run shadcn scans in a dedicated utility process and surface component, token, and diagnostic counts in the editor.
- [x] Add reusable native auth protocol foundations under `packages/auth`.
  - Generate PKCE, state, and nonce material using Web Crypto.
  - Strictly parse and single-consume the registered desktop callback with expiry and owning-window checks.
  - Keep hosted Better Auth, token exchange, storage, and renderer-safe session IPC in the control-plane task below.
- [ ] Replace the four-component fixture catalog with the shadcn catalog.
  - Add package identity, variants, named slots, source spans, preview support state, and writable provenance.
  - Remove the Button, Card, Input, and Label allowlists from preview bindings and inspector controls.
  - Keep unsupported exports visible with an explicit reason and never substitute copied JSX.
  - Verify against `AT-SCAN-001`, `AT-TOK-001`, and `AT-COMP-001` before calling import functional.
- [ ] Add incremental pull sync in the repository utility process.
  - Watch the granted repository, hash changed files, reparse affected dependencies, and emit typed catalog deltas.
  - Preserve opaque component IDs across verified moves and renames; block ambiguous or missing identities.
  - Keep the last good preview when current source fails to parse or build.
  - Verify against `AT-SYNC-001`, `AT-ID-001` through `AT-ID-003`, and `AT-PRV-002` through `AT-PRV-004`.
- [ ] Add reviewed push sync through semantic edit planners.
  - Use AST and PostCSS provenance for props, variants, tokens, and promoted components.
  - Compare scanned base, current source, and canvas intent before preparing a patch.
  - Require a fresh diff and explicit Save after every conflict choice or changed input.
  - Keep commit, push, and pull-request creation as separate explicitly authorized actions.
  - Verify against `AT-SYNC-002` and `AT-SRC-001` through `AT-SRC-006`.
- [ ] Add the hosted account and repository control plane.
  - Keep GitHub OAuth identity, GitHub App installation access, local repository grants, and project-to-repository bindings separate.
  - Add Better Auth and its OAuth 2.1 provider in server-only modules backed by PostgreSQL.
  - Add the native desktop public client, system-browser sign-in, PKCE, state, nonce, application-link callback, main-process token vault, and renderer-safe session view.
  - Add GitHub App installation verification, webhook invalidation, exact-repository grants, and server-side object authorization.
  - Verify against `AT-AUTH-001` through `AT-AUTH-003`, `AT-GHAPP-001`, and `AT-REPO-LINK-001`.

## Now: core editor interactions

- [x] Finish sidebar layer dragging.
  - Reorder siblings without changing their identity.
  - Move a node into and out of frames and groups while preserving its world position.
  - Make the drop target and resulting hierarchy unambiguous.
  - Support pointer cancellation, keyboard operation, undo, and redo.
  - Verify against `AT-CAN-001`, `AT-CAN-005`, and `AT-DOC-003`.
- [x] Finish component creation and usage.
  - Create a component from the current selection without flattening its children.
  - Insert and reuse real component instances from the component browser and sidebar.
  - Keep component identity, props, slots, source binding, and instance overrides intact.
  - Show every known use of a component and make selecting a use reliable.
  - Keep promotion and source-writing behind review and explicit Save approval.
  - Verify against `AT-P0-001`, `AT-PRV-001`, and `AT-UX-002`.

## Next: file-open startup quality

- [x] Remove the unstyled white flash when a file first loads.
  - Render the styled application shell and centered indeterminate loader from the first visible frame.
  - Ensure the critical theme and shell styles are available before the loading UI is painted.
  - Keep the loader position and canvas geometry stable when the client becomes interactive.
  - Diagnose whether the delay comes from hydration, late stylesheet loading, theme initialization, or a route-level client boundary before choosing the fix.
  - Test a cold launch and direct file URL with browser cache disabled and throttled loading.
  - Verify against `AT-UX-003` and `AT-PERF-001` with a recording that shows no flash or layout jump.

## Later: standalone files and accounts

- [ ] Make files fully usable outside the current local development environment.
  - Define the hosted file record, ownership model, revision checks, and server-enforced authorization.
  - Support authenticated create, list, open, rename, duplicate, delete, restore, and save flows.
  - Preserve local-first behavior and require explicit consent before any local repository content is uploaded.
- [ ] Add account creation and account management.
- [ ] Add system-browser sign-in for the desktop app.
- [ ] Add the registered application-link callback into Electron using PKCE and state validation.
- [ ] Keep tokens, cookies, and the auth client in the Electron main process; expose only required session display data through the typed preload API.
- [ ] Add session restore, sign out, expired callback, denied access, offline, and revoked-session states.
- [ ] Enforce object authorization for every file, project, repository, share, and sync operation.
- [ ] Verify the desktop round trip and negative controls in `AT-AUTH-001`, then complete `AT-AUTH-002` and `AT-AUTH-003`.
