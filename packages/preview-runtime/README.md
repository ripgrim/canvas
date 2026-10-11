# Isolated preview runtime

`createPreviewRuntime` builds actual client React exports with Vite in a separate child process and serves only accepted build assets on a random loopback port. The generated entry imports the selected repository module and its CSS. An optional provider binding wraps the selected component. React owns the preview root, including portals in its document.

```ts
const preview = createPreviewRuntime({
  repositoryRoot: fixtureRoot,
  editorOrigin: 'http://127.0.0.1:4319',
  executionTrust: 'fixture-only',
})
await preview.start({
  componentId: 'fixture-login',
  entryPath: 'src/PreviewLogin.tsx',
  exportName: 'PreviewLogin',
  styles: ['src/globals.css'],
  registry: [
    { componentId: 'atom-card', exportName: 'Card', entryPath: 'src/atoms/Card.tsx' },
    { componentId: 'atom-label', exportName: 'Label', entryPath: 'src/atoms/Label.tsx' },
    { componentId: 'atom-input', exportName: 'Input', entryPath: 'src/atoms/Input.tsx' },
    { componentId: 'atom-button', exportName: 'Button', entryPath: 'src/atoms/Button.tsx' },
  ],
})
```

Use the returned `url` in an iframe on the editor origin with `sandbox="allow-scripts allow-same-origin"`. The separate loopback origin preserves the cross-origin parent boundary. Never attach an Electron preload to the preview. Allow only that preview origin in the editor CSP. Validate incoming events with `acceptPreviewEvent`, including the actual iframe window and active generation. The browser entry validates both parent origin and parent window before applying JSON props or disposing its root. It exposes no filesystem, Node, Electron, auth or network capability.

The registry imports the exact modules named by a verified repository contract. Send `{ channel: 'design-editor-preview', version: 3, generation, type: 'set-document', document }` to render a validated editor document. Identity, bounded scalar props, frame limits, named slots, one-parent ownership, reachable nodes, size, and depth are checked independently at this boundary. Registry identities must match exactly. Text props and component slots cannot own the same slot simultaneously. Invalid commands are ignored; a valid document with an unregistered binding produces a diagnostic and keeps the last preview.

`verifyComponentRegistry` resolves every declared file inside the granted repository, verifies its named export, rejects privileged imports, computes SHA-256 integrity, and carries styles, a provider, theme adapters, fonts, and static assets into a shared build contract. Explicit `tsconfig.json` or `jsconfig.json` path aliases are checked against their hashed source and resolve only to repository-contained files. Every resolved local dependency is pinned, including nested styles and their assets. `verifiedRegistryPlugin` generates the runtime module used by both the editor preview and thumbnail renderer. A generated manifest can pin integrity values; stale files are refused. Verification reads declared configuration evidence but never executes repository configuration, scripts, or hooks.

Before the first document command, the original selected component executes with its original behavior, providers and portals. Document mode executes the real atom exports with their props and styles, but it does not carry the original composite's feature logic. The editor must disclose this mode change. `set-props` is reserved for the original component; document instances change through a new validated document. `set-theme` accepts only `light` or `dark` and sets `data-theme` on the preview document root, so the fixture's own canonical CSS tokens apply. Document frame dimensions, flex direction, gap, padding and clipping belong to the preview container rather than imported component source.

Actual fixture atoms forward adapter-owned `data-preview-instance` and `data-preview-component` attributes to their semantic DOM. Pointer selection reports the closest instance's ID, component ID and element bounds. The adapter does not flatten components or insert substitute wrappers. This mapping is fixture-specific: exports that do not forward attributes need a verified adapter before document editing is supported. Disposal unmounts the React root and removes message, pointer and diagnostic listeners. Removed instances are unmounted by React reconciliation.

`set-interaction-mode` accepts `mode: 'select' | 'pan' | 'interact'`. Interact is the initial mode, preserving the selected composite's original input and button behavior. Select captures pointer input and reports selection while suppressing native focus, click activation and editing. Pan suppresses preview interactions and selection; the parent canvas owns the actual pan gesture. Tab navigation remains available. The parent resends mode after every accepted preview generation.

`snapshot` is a stable cached object until the service changes. `subscribe` returns listener cleanup. `rebuild` advances a generation before work starts, discards obsolete results, and retains the last successful URL with `stale: true` and diagnostics on failure. `stop` closes workers and the HTTP server and removes build directories. `dispose` also clears subscribers and prevents restart. The editor must dispose the old iframe root before switching URLs or removing the iframe, then call `releaseGeneration` for its retired build to remove those assets. Until released, retired assets remain available for dynamic imports by the previous iframe. A new bundle resets React state; this adapter does not promise hot state preservation. The registered standard secure `design-editor://app` Electron origin is also accepted; registration belongs to Electron main.

`validatePreviewFiles(options, binding, files)` accepts a full repository-relative `src` tree, including new files. It stages that tree outside the source repository, links the existing fixture dependencies, builds the candidate binding with real Vite, and disposes the temporary preview. It throws on parse, import or build failure. The source engine uses this result as a required Save validation. This helper currently covers only the fixture's `src` assets and does not copy arbitrary repository assets.

This adapter still requires the explicitly scoped `fixture-only` execution grant. The build process strips inherited environment variables, does not load repository configuration or env files, and does not run package scripts. These restrictions do not replace an OS sandbox. Imported browser modules execute only on the isolated preview origin, but compile-time module transformation still needs an operating-system sandbox before arbitrary repositories are supported. Repository providers, fonts, and assets must be declared explicitly. Next.js server components, automatic provider detection, framework configuration, hot reload, source-to-element fiber mapping, and automatic external-file watching are not supported here. Call `rebuild` from the repository engine's explicit refresh command.

Package tests cover exact origin and sender rejection, stale generation rejection, document negative controls, registry identity and path denial, real Vite bundle serving, HTTP method and path denial, last-good retention, and port disposal. Browser isolation, interactive login, provider and portal behavior require the cross-boundary Playwright suite.
