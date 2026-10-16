# Canvas-authored component closure

## Goal

Finish and verify the canvas-authored component system before beginning repository source sync. A component created on the canvas must have stable identity, linked instances, understandable authoring controls, faithful runtime behavior, reversible history, and complete browser evidence.

## Scope

- Component definitions, instances, properties, variants, slots, materials, parts, interactions, Kit details, playground, and variant sheets.
- Shared document-model, preview-runtime, affine-transform, history, and persistence behavior required by canvas components.
- Focused component tests and `PR-EVIDENCE-014` screenshots and recording.

## Not in scope

- New scanner behavior.
- GitHub App or repository-job behavior.
- Hosted source-writing adapters.
- New repository preview or Blume publication capabilities.

## Phases

1. Acceptance ledger
   - Map `COMP-V2-PERSIST-*`, `COMP-V2-AUTHOR-*`, `COMP-V2-HISTORY-*`, `COMP-V2-INSTANCE-*`, `COMP-V2-UI-001..072`, and `PR-EVIDENCE-014` to direct evidence.
   - Record missing assertions and negative controls before changing implementation.
2. Semantic closure
   - Verify stable identity, linked-subtree mirroring, nested-instance recursion guards, binding migration, sparse reset, removal, detachment, Undo, and affine instance-root authority.
3. Authoring intent
   - Verify descriptions and limits, explicit edit scope, separate Variant schema and canvas appearance state, material capture, rebinding capture, and Create component to Kit navigation.
4. Runtime projection
   - Verify configured previews, Variant and Material projection, Hover and Pressed interactions, nested component parts, and honest unavailable behavior.
5. UI evidence and closure
   - Run `PR-EVIDENCE-014`, capture the required external evidence, verify reload and Undo, then run focused component tests, type checks, and contract checks.
6. Hosted collaboration and persistence closure
   - Prove a complete, non-empty component graph converges across two real WebSocket clients and survives PostgreSQL persistence, room restart, reconnect, and reload.
   - Reject stale component replacements and stale history inverses without mutating the authoritative projection.
   - Preserve stable identities, bindings, sparse overrides, materials, parts, interactions, nested slot instances, and master/instance separation.
   - Gate the slice with `COMP-V2-PERSIST-001`, `COMP-V2-PERSIST-NEG-001`, `COMP-V2-AUTHOR-001`, `COMP-V2-HISTORY-001`, `COMP-V2-INSTANCE-002`, `COMP-V2-INSTANCE-HISTORY-001`, `CLOUD-SYNC-COMPONENT-001`, and `CLOUD-SYNC-LIFECYCLE-003`.

## Closed slice: component-root interaction runtime

Hover and Pressed now belong to the exact component boundary, may project onto a nested bound layer, isolate nested components through nearest-owner precedence, and restore the configured instance state after every terminal pointer or preview interruption. Repository scanning, GitHub, Blume generation, source writes, new inspector controls, persistent interaction state, and new trigger types remain excluded.

Owned implementation paths:

- `packages/repo-engine/src/file-preview.ts`
- `packages/repo-engine/tests/file-preview.test.ts`
- `packages/preview-runtime/src/protocol.ts`
- `packages/preview-runtime/src/browser-runtime.mjs`
- `packages/preview-runtime/tests/scene-protocol.test.ts`
- `packages/preview-runtime/tests/protocol-negative-controls.test.ts`
- `packages/preview-runtime/tests/component-interaction-browser-runtime.test.ts`

The orchestrator owns the protocol-version integration cutover in `apps/desktop/src/main/index.ts`, the editor preview-connection fixtures, and the remaining preview-runtime protocol fixtures. Those consumers change only from envelope version 9 to 10 or preview-document version 2 to 3.

Evidence updates extend only to `tests/pr-evidence/scenarios/component-system.spec.ts`, `tests/pr-evidence/registry.json`, and `ACCEPTANCE-TESTS.md`.

## Closed slice: configured Slot playground

The Kit playground will configure bound Slot content before placement. Text, Frame, and eligible canvas components become transient draft recipes, render in the isolated configured preview without changing the authoritative file, and place with the outer instance as one checked transaction and one Undo leaf.

Owned implementation paths:

- `packages/editor/src/features/editor/component-configured-instance.ts`
- `packages/editor/src/features/editor/component-configured-instance.test.ts`
- `packages/editor/src/features/editor/component-configured-preview.ts`
- `packages/editor/src/features/editor/component-configured-preview.test.ts`
- `packages/editor/src/features/editor/component-docs-preview-service.ts`
- `packages/editor/src/features/editor/component-docs-preview-service.test.ts`
- `packages/editor/src/features/editor/ComponentKitPanel.tsx`
- `packages/editor/src/features/editor/ComponentKitPanel.client.test.ts`
- `packages/editor/src/features/editor/component-kit-copy.ts`
- `packages/editor/src/features/editor/document-store.ts`
- `packages/editor/src/features/editor/document-store.test.ts`
- `tests/pr-evidence/scenarios/component-system.spec.ts`
- `tests/pr-evidence/registry.json`
- `ACCEPTANCE-TESTS.md`

The slice is gated by `COMP-V2-UI-075`, `COMP-V2-UI-NEG-002`, and the extended `PR-EVIDENCE-014`. It excludes repository or source sync, source writes, persistence or protocol migrations, persisted playground drafts, arbitrary child editing, instance-swap properties, compound Variant composition, preview drag/reorder, and new styling primitives.

The Kit now owns transient Slot recipes separately from scalar instance values. One pure planner validates and materializes Text, Frame, and eligible canvas-component children for both the isolated preview scratch file and the final placement transaction. Stale bindings, unavailable code components, duplicate draft identities, and recursive component graphs fail closed. Browser evidence proves draft changes leave the stored file untouched, Place writes the complete tree, and one Undo removes it.

## Closed slice: canvas-authored Instance swap properties

A component master may expose one nested canvas-component use as a typed Instance swap property. The default is the nested component's current definition. The Kit playground and selected-instance inspector may choose another eligible canvas component, preview it without changing authoritative bytes, place or apply the complete replacement atomically, reset to the latest master default, and Undo or Redo the whole semantic and physical subtree as one history leaf.

Dependency order:

1. Add the validated model and default-resolution contract.
2. Add one pure stable-root swap planner with recursion, identity, and availability checks.
3. Integrate atomic set, reset, property removal or rebinding, placement, history, and linked-master reconciliation.
4. Add authoring, Kit, and instance controls using the existing Wonder component vocabulary.
5. Route configured preview and placement through the same planner.
6. Extend browser evidence and close the acceptance ledger.

The slice is gated by new `COMP-V2-UI-076`, new `COMP-V2-UI-NEG-003`, and the extended `PR-EVIDENCE-014`. Regression gates are `COMP-V2-UI-010`, `COMP-V2-UI-025`, `COMP-V2-UI-027`, `COMP-V2-UI-030`, `COMP-V2-UI-035`, `COMP-V2-PERSIST-001`, and `COMP-V2-HISTORY-001`.

The implementation preserves the bound root identity, relationship order, pose, outer-instance identity, and unrelated overrides. It rejects stale or unbound targets, non-instance targets, missing or unavailable definitions, direct or ancestor recursion, duplicate bindings, invalid stored component ids, and partial-clone failures before any document or history mutation. It excludes code-component swaps, preferred-value subsets, outer-component replacement, arbitrary Slot editing or reorder, compound Variants, new interaction triggers, persisted playground drafts, repository or source sync, source writes, and protocol or schema migrations.

The completed slice also gives each open Kit detail view one event-owned, memory-only playground session. Temporary preview iframe remounts and definition-readiness gaps preserve valid scalar, Slot, and Instance swap drafts for the same file, component, and navigation sequence. Back navigation or a real context change retires the session. Authoritative file writes remain gated by the current document model and the checked swap planner.

## Closed slice: compound canvas Variant appearances

Two or more Variant properties may target the same real layer and resolve one exact authored appearance for the complete value tuple. The master Canvas edits selectors define the current tuple. Appearance edits capture only that cell. Kit preview, placement, generated sheets, interactions, linked instances, reload, and Undo or Redo must resolve the same cell without sequential last-write behavior.

Dependency order:

1. Add the bounded exact-combination model, canonical tuple helpers, validation, and schema migration.
2. Replace sequential Variant projection with one grouped resolver per bound node.
3. Make add, remove, value edits, rebinding, capture, reset, and linked propagation reconcile cells atomically.
4. Permit same-layer Variant authoring with the existing compact controls and no explanatory empty-state copy.
5. Extend Kit, interaction, persistence, history, and browser evidence across a visible 2 by 2 State and Tone grid.

The slice is gated by new `COMP-V2-UI-077`, new `COMP-V2-UI-NEG-004`, and extended `PR-EVIDENCE-014`. It retains regressions for `COMP-V2-UI-009`, `COMP-V2-UI-010`, `COMP-V2-UI-013`, `COMP-V2-UI-023`, `COMP-V2-UI-024`, `COMP-V2-UI-033`, `COMP-V2-UI-035`, `COMP-V2-UI-036`, `COMP-V2-UI-037`, `COMP-V2-PERSIST-001`, and `COMP-V2-HISTORY-001`.

It excludes layout, size, and text-style Variant capture, code-component enums, preferred subsets, Slot reorder or arbitrary editing, new interaction triggers, persisted playground drafts, repository or source sync, Blume writes, operation-envelope and runtime-protocol behavior changes, and appearance interpolation. Persisted document metadata advances from schema 12 to 13 for the exact appearance table. The rollback boundary is one schema-complete staging commit based on `1e267c0`.

The completed slice stores one exact appearance per bounded Variant tuple, rejects incomplete current-schema tables and more than 256 total combinations, migrates legacy compound definitions explicitly, and resolves nested Instance swap boundaries without abandoning the owning component projection. Value and axis removal, master Undo or Redo, linked instances, interaction targets, generated sheets, and reload all use the same canonical tuple contract. Fresh `PR-EVIDENCE-014` browser evidence captures the master, configured playground, and generated sheet; the full editor and repository-engine suites pass.

## Closed slice: advanced component collaboration and persistence parity

A complete schema-13 canvas-component graph must converge byte-for-byte across two real WebSocket clients and survive room drain, restart, reconnect, and persisted projection. The fixture combines two Variant axes on one layer with an exact tuple table, a nested canvas component exposed through Instance swap, Slot content, Text and Boolean overrides, materials, parts, interactions, and independent master and instance transforms. Valid updates keep one live socket. Rejected updates leave sequence, projection digest, semantic records, physical nodes, and relationships unchanged.

Dependency order:

1. Build one literal advanced graph fixture without production planners computing the expected values.
2. Prove two-client convergence for compound appearance and Instance swap changes.
3. Add stale replacement, stale inverse, malformed table, invalid swap-root, mutation-id replay, and persisted-digest negative controls.
4. Drain and recreate the room, reconnect a fresh client, and compare the restored graph with the independent expected fixture.
5. Prove the web adapter retains one socket while advanced metadata changes.
6. Exercise the existing disposable PostgreSQL contract only when its explicit environment is available.
7. Extend browser evidence as visual reload and reconnect confirmation without treating screenshots as persistence proof.

The slice is gated by new `CLOUD-SYNC-COMPONENT-002`, new `CLOUD-SYNC-COMPONENT-NEG-002`, and extended `PR-EVIDENCE-014`. Regression gates are `CLOUD-SYNC-COMPONENT-001`, `CLOUD-SYNC-LIFECYCLE-003`, `COMP-V2-PERSIST-001`, `COMP-V2-PERSIST-NEG-001`, `COMP-V2-AUTHOR-001`, `COMP-V2-HISTORY-001`, `COMP-V2-INSTANCE-002`, `COMP-V2-INSTANCE-HISTORY-001`, `COMP-V2-UI-076`, `COMP-V2-UI-NEG-003`, `COMP-V2-UI-077`, and `COMP-V2-UI-NEG-004`.

It excludes repository or source sync, GitHub, scanning, repository jobs, hosted building, Blume publication, new component features, inspector changes, and protocol or schema changes without a separately reviewed production defect. The rollback boundary is one collaboration-focused staging commit based on `b05a65f`.

The completed slice proves the literal schema-13 graph across two live WebSocket clients, room restart, durable reconnect, one-socket web authoring, and a real disposable PostgreSQL roundtrip. Independent expected documents cover compound appearance projection and a physical Instance swap. Negative controls reject stale writes, mutation-id reuse, malformed tuple tables, invalid swap roots, and persisted digest mismatches without weakening revision or schema fences.

## Completed slice: first-class canvas component duplication

Canvas components must retain semantic identity through every file-local duplication path. Duplicating a master creates a new independent canvas component with fresh graph identities and a unique copy name. Duplicating or copy-pasting an instance creates another instance linked to the same master while preserving its configured subtree, sparse values, Slot content, Instance swap selection, transform, and nested semantic instances. One Undo or Redo owns the complete semantic and physical clone.

Dependency order:

1. Add one pure semantic clone planner that remaps the definition graph, node-bound references, compound Variant table, materials, parts, interactions, and nested component records.
2. Route Duplicate and Alt-drag through the checked planner as one batch and one history leaf.
3. Admit same-file canvas-component closures at the clipboard boundary with exact-key, size, recursion, identity, and dependency validation.
4. Reuse the same planner for clipboard insertion instead of flattening component roots.
5. Extend browser evidence across master duplication, configured-instance paste, Undo, Redo, reload, Layers identity, Kit identity, and Kit Uses.
6. Independently review semantic identity remapping and the untrusted clipboard boundary before closure.

The slice is gated by new `COMP-V2-UI-078`, new `COMP-V2-UI-NEG-005`, and extended `PR-EVIDENCE-014`. Regression gates are `COMP-V2-HISTORY-001`, `COMP-V2-UI-011`, `COMP-V2-UI-012`, `COMP-V2-UI-016`, `COMP-V2-UI-017`, `COMP-V2-UI-018`, `COMP-V2-UI-025`, `COMP-V2-UI-027`, `COMP-V2-UI-030`, `COMP-V2-UI-076`, `COMP-V2-UI-077`, and `PAPER-CLIP-003` through `PAPER-CLIP-005`.

It excludes cross-file canvas-component portability, code-component root clipboard support, repository scanning, GitHub, source patches, Blume writes, publication, new property types, new triggers, and schema or runtime protocol changes. Invalid property bindings, tuple cells, nested identities, component revisions, recursion edges, and clipboard relationships fail before changing document bytes, history, selection, or Kit usage. The rollback boundary is one duplication-focused staging commit based on `807fc7e`.

The completed slice gives Duplicate, modifier-copy, Alt-drag, page duplication, and same-file paste one checked semantic clone planner. Master copies receive fresh and fully remapped component identities; configured instance copies preserve their source identity, sparse values, Slot content, Instance swap choice, and nested semantic instances. Fresh `PR-EVIDENCE-014` browser evidence proves Layers and Kit identity, one-step Undo or Redo, and reload persistence, while malformed, recursive, stale, oversized, cross-file, and paste-to-replace inputs fail before mutation.

## Current status

- Staging is organized as one reversible commit per closed slice.
- Theme-token deletion uses one reference-aware path for editor and context-menu actions.
- The complete component browser workflow passes, including a centered configured-preview assertion.
- The hosted collaboration boundary now has a complete two-client real-WebSocket graph test, stale-write and mutation-id negative controls, and room restart recovery.
- Component-root Hover and Pressed ownership, nested target projection, nearest-owner isolation, cancellation restoration, Select and Pan inertness, and root-padding browser evidence are complete under `COMP-V2-UI-073`, `COMP-V2-UI-074`, and `PR-EVIDENCE-014`.
- Configured Slot drafts, isolated preview rendering, atomic placement, recursive-nesting rejection, and one-step Undo are complete under `COMP-V2-UI-075`, `COMP-V2-UI-NEG-002`, and `PR-EVIDENCE-014`.
- Canvas-authored Instance swap defaults, transient Kit preview, atomic placement and instance updates, reset, deletion fallback, recursion rejection, exact Undo or Redo, and remount-stable playground sessions are complete under `COMP-V2-UI-076`, `COMP-V2-UI-NEG-003`, and `PR-EVIDENCE-014`.
- Compound State and Tone appearances, canonical tuple persistence, bounded migration, grouped projection, value or axis removal, master Undo or Redo, reload, interactions, configured previews, and generated sheets are complete under `COMP-V2-UI-077`, `COMP-V2-UI-NEG-004`, and `PR-EVIDENCE-014`.
- First-class canvas master and configured-instance duplication, fresh graph remapping, same-file clipboard insertion, atomic Undo or Redo, reload persistence, and closed malformed-input boundaries are complete under `COMP-V2-UI-078`, `COMP-V2-UI-NEG-005`, and `PR-EVIDENCE-014`.
- Advanced schema-13 component fixtures now cover real two-client WebSocket convergence, physical compound projection, a real Instance swap to a second component, full-document restart recovery, durable client reconnect, one-socket web authoring, and malformed-graph rejection under `CLOUD-SYNC-COMPONENT-002` and `CLOUD-SYNC-COMPONENT-NEG-002`.
- The interaction wire cutover is explicit at preview envelope version 10 and preview document version 3. Stale version 9 envelopes and version 2 documents fail closed.
- PostgreSQL advanced component graph persistence passed against a fresh disposable `postgres:16-alpine` database and the container was removed after verification.
- Repository source sync remains deferred.
