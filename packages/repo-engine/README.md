# Repository engine

This package implements the source-writing proof for the controlled component fixture. It indexes configured atom barrels without executing repository scripts and exposes task-level methods for Electron's isolated repository worker.

```ts
const engine = await createRepoEngine(projectRoot, { validatePreview })
const proposed = await engine.prepareLabelPadding('8px 12px')
const saved = await engine.savePrepared(proposed.id, proposed.approvalDigest)
```

`validatePreview` must compile the complete staged source tree using the preview adapter. A missing validator is reported as `not-run` and blocks Save. The callback receives the current project root, complete candidate source files, and proposed entry binding. Validation never grants permission to execute arbitrary imported project configuration.

The fixture adapter uses `src/atoms/index.ts`, `src/components/index.ts`, `src/PreviewLogin.tsx`, and canonical `src/globals.css`. It discovers JSX-returning function declarations through TypeScript symbols. Other export shapes, arbitrary design-system root detection, CSS-in-JS, computed padding, server components, and arbitrary repository execution require later adapters.

Opaque component IDs live in `.design-editor/identity.json`. A moved or renamed symbol becomes a proposed candidate. `confirmIdentity` requires a current structural match before preserving its ID at the new binding. Deleted identities remain recorded. Multiple candidates block source writes.

Prepare captures source and package-manager/configuration input hashes, parses candidate TSX and CSS, checks types, builds the preview, and returns exact diffs. Its SHA-256 approval covers inputs, patch bytes, scope, adapter and validation versions, and composition state. Returned data is cloned so callers cannot mutate a prepared transaction.

Save holds a project transaction lock, rechecks inputs, writes a durable recovery journal, checks each original immediately before replacement, and replaces files with flushed temporary files. Multi-file replacement uses rollback, not a claim that the filesystem has a native multi-file atomic primitive. Rollback refuses to overwrite intervening external edits. In that case the journal retains original and candidate bytes for manual recovery. A crash or failed rollback blocks later saves; automatic crash recovery UI is not implemented yet.

`prepareUndo` builds a reviewed reverse transaction only while the saved bytes still match. Any later edit produces a conflict. Undo history currently lasts for the engine session. Instance prop editing, general composition editing, automatic conflict merges, Git history reconciliation, persistent undo, source-span to runtime-element mapping, and general project connection remain outside this fixture engine's verified scope.

The fixture's initial login is real code. Promotion preserves that source and its provider, portal, state, atom imports, and typed props, then creates the reviewed module/export pair and rebinds the composition. It does not yet serialize arbitrary canvas compositions or prove runtime state survives module replacement.

Run the package checks from the workspace:

```sh
node node_modules/typescript/bin/tsc --noEmit -p packages/repo-engine/tsconfig.json
node node_modules/vitest/vitest.mjs run packages/repo-engine/tests/engine.test.ts
node node_modules/typescript/bin/tsc -p packages/repo-engine/tsconfig.build.json
node packages/repo-engine/scripts/inspect-prepare.mjs
```

Tests use disposable real repositories, actual Vite candidate builds, independent golden source bytes, deliberate external edits, a real directory-junction escape, and an injected failure between filesystem replacements. The rollback negative control verifies that a deliberately corrupted result fails the byte-equality invariant. It is not presented as a complete mutation-testing campaign.
