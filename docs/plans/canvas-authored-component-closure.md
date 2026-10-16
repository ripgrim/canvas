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

## Active slice

Hosted collaboration and persistence closure is the only active implementation slice. Start with a failing two-client real-WebSocket test, add stale-command negative controls, then extend PostgreSQL restart persistence. Production changes are allowed only when those boundary tests expose a defect. Repository scanning, GitHub, Blume generation, source writes, schema expansion, and new component UI are excluded.

Owned implementation paths:

- `apps/sync-room-core/tests/network.test.ts`
- `packages/database/tests/collaboration-postgres-acceptance.mjs`
- `apps/web/src/adapters/cloud.test.ts`
- `apps/web/src/adapters/cloud.ts`
- `packages/sync-client/tests/collaboration-client.test.ts`
- `packages/sync-client/src/collaboration-client.ts`

If the boundary proves defective, changes may extend only to `apps/sync-room-core/src/projector.ts`, `apps/sync-room-core/src/room-core.ts`, or `packages/database/src/collaboration.ts`. A required schema or component-semantic change stops this slice and becomes a separately reviewed migration.

## Current status

- The prior dirty tree is clean and split into nine reversible commits on `staging` through `685918a`.
- Theme-token deletion uses one reference-aware path for editor and context-menu actions.
- The complete component browser workflow passes, including a centered configured-preview assertion.
- Hosted collaboration and persistence closure is planned and has not started implementation.
- Repository source sync remains deferred.
