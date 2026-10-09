# Verification record

This file records fresh checks of the actual project at `C:\Users\grim\code\design-editor`. Cached results and earlier thread reports are not current proof.

## Current result on 2026-10-07 at 03:52 UTC

The previously blocked ten-file integration succeeded at the final project path after fresh explicit authorization. Source and destination hashes matched for all ten files after integration. The readonly API assignment in the new history test was corrected. The earlier blocked/staging-only notes below are historical.

| Command at the actual project root | Fresh result |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run` | 151 tests passed in 14 files, 125.48 seconds |
| `pnpm -r typecheck` | Passed |
| `node scripts/check-contracts.mjs` | Passed |
| `pnpm -r build` | Passed |
| `node apps/desktop/tests/ui-interactions.mjs` | Passed, 12 actual-control groups, no bridge invocations |
| `node apps/desktop/tests/launch-smoke.mjs` | Passed, independent IPC and source/disk checks |

The native control run verified real Button insertion and typed props, Select versus Interact input behavior, nested layers, multiselect, duplicate, reorder, slot nesting, keyboard input exclusions, frame layout/keyboard resize, pan/zoom/fit, reviewed shared Label Save and source undo/redo, external-edit protection and Sync recovery. Quit/reopen restored exact document identities; reopened undo and redo restored independently expected frame heights 640 and 650.

Evidence is in `outputs/ui-interactions-report.json`, `outputs/ui-light.png` and `outputs/ui-dark.png`. The isolated preview appears as a separate Electron iframe debugger target; the observer attaches to the exact rendered frame URL. All controls use real mouse/keyboard dispatch. Source and identity assertions read disk independently. Temporary test repositories and profiles were removed, and the checked-in fixture source was unchanged.

The independent launch smoke uses direct IPC rather than control clicks. It verified malformed request/digest denial, exact Label and canonical token patches, external source conflict, default login promotion preserving provider/portal source, and persistent atom/project/promoted identities. Its old undo-description string is stale; source undo control evidence comes from the native control suite above.

A real resize focus failure was corrected by focusing the handle in its pointer event. Desktop typecheck, contract lint and build passed after that fix, followed by the successful native control rerun. The earlier iframe-observer and resize failure images are historical.

Scoped visual review found coherent Wonder light/dark tokens and shell hierarchy. The captures include a transient document-save phase; settled captures and visible canvas selection feedback are the next verification work. Licensed font files remain unavailable. macOS keys, arbitrary repositories, GitHub, hosted auth/share, SVG/text/image tools, snapping and broader release features are not claimed complete. Edited composition promotion still explicitly excludes application callbacks/providers and frame viewport settings.

## Baseline verified on 2026-10-07 at 02:35 UTC

The project contains `apps/desktop`, `packages/repo-engine`, `packages/preview-runtime`, `fixtures/component-repo`, the six-method typed preload contract and a native Electron launch smoke. No document editing or source undo UI extension is present in this baseline.

| Command at the actual project root | Fresh result |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run` | 72 tests passed in 10 files, 55.93 seconds |
| `node scripts/check-contracts.mjs` | Passed |
| `pnpm -r build` | Passed for fixture, engine, preview runtime and desktop renderer/main/preload |
| `pnpm -r typecheck` | Passed for all four source packages |
| `npx -y react-doctor@latest . --verbose` | 65/100, five warnings, reviewed below |

React Doctor scanned 33 files. The iframe warning is contradicted by the actual sandbox attribute on PreviewFrame. The fixture portal warning concerns imported source and is not authority to rewrite it. Independent awaits in the fixture grant are low-risk sequencing. Editor complexity and keyboard semantics will be checked during interaction integration. No dependency or React Doctor setup was installed into this project.

Native Electron interaction and visual results for the next milestone are pending. The previous renderer UI-REVIEW crash note is historical, not a current verdict. No screenshot or successful launch result is inferred from build artifacts or test cache.

The next slice adds persisted document commands, real atom composition, props/slots/layout/pan/zoom and reviewed source undo/redo. Arbitrary repository execution, GitHub, hosted auth/share, SVG/text/image tools and broader release features remain unimplemented. Execution stays fixture-only until an OS sandbox exists.

## Interaction integration checked on 2026-10-07

Before the final history integration, fresh checks at the actual project root passed: 126 tests in 12 files, 129.11 seconds; full typecheck; contract lint; production builds. That project includes real atom insertion, nested layers, properties and slots, frame layout/resize, pan/zoom, document commands and reviewed source undo/redo. The preload exposes nine narrowly typed methods.

The native mouse/keyboard runner failed at its preview observer. `outputs/ui-failure.png` visibly contains the inserted real Button and its edited properties, but that image is not proof of a completed interaction suite. `outputs/ui-interactions-report.json` records the failure. The staged runner now handles separate iframe debugger targets, but has not been run at the final location. Light/dark completion screenshots and native reopen undo checks are pending.

The later history work remains staged, not integrated: project-scoped validated undo cache, persistent editor session partition, explicit store wiring and an extended native runner. A staging-only run passed 43 tests across document-history, document-store, editor-store and store-history. The new store-history integration test still has a TypeScript error from assigning a readonly API method; passing runtime tests do not clear that error.

Automatic approval review rejected the scoped final-folder copy. Its reason was that this thread's trusted opening request authorizes handoff documents and excludes application implementation. Later parent-thread build authorization was recovered through a read-only thread lookup, but the approval reviewer did not accept tool output as refreshed authorization. No file from the rejected ten-file copy was written. Further application writes and final native verification require explicit current authorization. Do not infer completion from these staged changes.
