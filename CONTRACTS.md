# Build contracts

The first executable vertical slice uses these ownership boundaries.

- `apps/desktop/src/main/**` and `apps/desktop/src/preload/**`: Electron security and typed IPC.
- `apps/desktop/src/renderer/design-system/**`: first-party atoms, molecules, and theme.
- `apps/desktop/src/renderer/features/**`: editor organisms and feature copy.
- `apps/desktop/src/renderer/pages/**`: composition-only pages.
- `packages/repo-engine/**`: repository discovery, source provenance, patches, identity, and transactions.
- `fixtures/component-repo/**`: imported repository test fixture. It is not governed by first-party page architecture lint.
- `tests/**`: cross-boundary and acceptance tests.

The desktop renderer calls only the typed `window.designEditor` API. The initial contract is:

```ts
type DesignEditorApi = {
  inspectFixture(): Promise<ProjectSnapshot>
  prepareLabelPadding(padding: string): Promise<PreparedChange>
  prepareToken(value: string): Promise<PreparedChange>
  preparePromotion(name: string): Promise<PreparedChange>
  savePrepared(id: string, approvalDigest: string): Promise<SaveResult>
  refresh(): Promise<ProjectSnapshot>
}
```

`ProjectSnapshot` contains discovered atoms, mutable source bindings, persistent IDs, source hashes, current composition state, and any conflict. Prepared changes contain exact diffs and validation results. Source writes require a current approval digest and matching hashes.

No package may use React effects. External stores expose stable snapshots through `useSyncExternalStore`. The UI uses the installed Wonder theme tokens from `GUI.md` and `gui/themes/wonder.md`.
