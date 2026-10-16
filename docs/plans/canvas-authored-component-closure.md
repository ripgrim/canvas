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

## Current status

- Dirty-tree cleanup and reversible staging commits are in progress.
- Theme-token deletion now uses one reference-aware path for editor and context-menu actions.
- The complete component browser workflow currently passes, including a centered configured-preview assertion.
- Repository source sync remains deferred.
