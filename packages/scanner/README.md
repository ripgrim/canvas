# Scanner preview registry

`scanShadcnPreviewRegistry(repositoryRoot)` reads shadcn component and token sources and returns two values:

- `scan`, including components, tokens, source hashes, and explicit unsupported diagnostics.
- `request`, the version 1 verified component registry request shared by the editor preview and thumbnail renderer.

Every component and stylesheet in the request carries a SHA-256 integrity value. Component IDs derive from the repository-relative source path and export name, so an edit changes the registry fingerprint without changing component identity. The scanner carries explicit `tsconfig.json` or `jsconfig.json` path aliases. The verifier resolves those aliases only to repository-contained files and pins the complete local import and stylesheet dependency graph.

Static images and fonts are exposed only when the verified source or stylesheet graph references them. Provider and theme adapter entries must be declared under `designEditor.preview` in `components.json`; the scanner does not guess them. Props outside the preview contract are reported as `unsupported-preview-component` and are not approximated.

The scanner does not write repository files, execute repository scripts, install packages, or run package-manager hooks.

## Desktop handoff

The desktop connection service verifies the request again and writes this generated file under Electron app data:

```json
{
  "repositoryRoot": "C:/absolute/connected/repository",
  "registry": {}
}
```

The absolute generated manifest path is supplied as `CANVAS_VERIFIED_COMPONENT_REGISTRY`. Both the editor preview on port 4318 and the thumbnail renderer on port 4323 consume that same environment variable at Vite configuration startup.

Vite loads the registry once. A repository connect or rescan that changes the fingerprint therefore requires both consumers to restart or rebuild before they can render the new contract. Reusing the prior request after any bound source, alias target, module configuration, nested stylesheet, or local asset change fails verification.

Local orchestration must set the environment variable before starting either consumer. It must not silently replace a missing connected registry with an empty registry.
