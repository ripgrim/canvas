# Design editor

Design editor is an Electron desktop editor that connects a real React repository to a React and DOM design canvas. The first vertical slice discovers design-system atoms, composes a login screen, prepares scoped minimal source patches, detects external changes, and promotes the composition into a real TSX component.

Read `START-HERE.md`, `AGENTS.md`, and `PRODUCT-SPEC.md` before contributing. For UI work, read `GUI.md` and use the installed Graphical skills.

## Development

Prerequisites:

- Node.js 24
- pnpm 10.6.2

Install and verify:

```sh
pnpm install
pnpm verify
```

Run the desktop development build:

```sh
pnpm dev
```

The bundled fixture is disposable test data. Source-writing tests copy it to a temporary directory before applying changes.

## Current boundary

The first supported repository shape is a client React and Vite project. Next.js server components and server-only imports are detected as unsupported until a dedicated adapter exists. Authentication, hosted sharing, and PostgreSQL services are specified but are not represented as working until their real server modules and acceptance tests exist.
