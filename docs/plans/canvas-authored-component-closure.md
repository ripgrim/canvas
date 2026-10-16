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

## Current status

- The prior dirty tree is clean and split into reversible commits on `staging` through `771515d`.
- Theme-token deletion uses one reference-aware path for editor and context-menu actions.
- The complete component browser workflow passes, including a centered configured-preview assertion.
- The hosted collaboration boundary now has a complete two-client real-WebSocket graph test, stale-write and mutation-id negative controls, and room restart recovery.
- Component-root Hover and Pressed ownership, nested target projection, nearest-owner isolation, cancellation restoration, Select and Pan inertness, and root-padding browser evidence are complete under `COMP-V2-UI-073`, `COMP-V2-UI-074`, and `PR-EVIDENCE-014`.
- Configured Slot drafts, isolated preview rendering, atomic placement, recursive-nesting rejection, and one-step Undo are complete under `COMP-V2-UI-075`, `COMP-V2-UI-NEG-002`, and `PR-EVIDENCE-014`.
- The interaction wire cutover is explicit at preview envelope version 10 and preview document version 3. Stale version 9 envelopes and version 2 documents fail closed.
- PostgreSQL component graph persistence coverage is implemented and type-checked, but the real disposable-database run remains open because this shell does not provide `COLLABORATION_TEST_DATABASE_URL` or `COLLABORATION_TEST_ALLOW_DISPOSABLE=1`.
- Repository source sync remains deferred.
