# Component docs

Use the component model as the source for Blume component pages.

## Build the catalog

Pass the validated file model to `componentDocsCatalog`:

```ts
import { componentDocsCatalog } from '@canvas/repo-engine/component-model'

const catalog = componentDocsCatalog(file.componentModel, usageSnippets)
```

The catalog provides:

- `navigation` for the component section in `blume.config.ts`
- `controls` and `combinations` for the live example in `registry/comp`
- `route`, `description`, and `usage` for the MDX page in `content/docs`
- `openInCanvas.componentId` for the editor deep link

## Supply usage code

Pass a usage snippet only after the repository adapter resolves the real import and props. A code component without that adapter returns `source-adapter-required`. A canvas component returns `canvas-source` until it is promoted to source.

Blume should render either the supplied snippet or the unavailable state. It must not infer an import path, export name, or prop spelling from a display name.

For a connected repository, store the reviewed mapping at `.canvas/blume.json`:

```json
{
  "version": 1,
  "renderer": "blume",
  "layout": {
    "docsDirectory": "apps/docs/docs/components",
    "examplesDirectory": "apps/docs/registry/comp",
    "metaPath": "apps/docs/docs/components/meta.ts",
    "manifestPath": "apps/docs/.canvas/components.json"
  },
  "components": [
    {
      "componentId": "shadcn:Button:verified-id",
      "slug": "button",
      "importSpecifier": "@trycompai/design-system",
      "examplePath": "button/examples/button-generated",
      "description": "Triggers an action."
    }
  ]
}
```

The repository worker loads this bounded file from the checked source snapshot. The component ID and export must also exist in the verified scanner result. The adapter supplies repository intent; it does not grant access or make an unverified component writable.

## Prepare reviewed Blume files

Use `planBlumeComponentDocs` with the validated catalog, one exact example-source adapter per supported component, and the reviewed current `meta.ts` source. The plan targets the current Blume layout under `apps/docs/docs/components` and `apps/docs/registry/comp`, but it does not write those files. It parses the navigation as TypeScript and adds generated slugs without replacing unrelated pages. Ambiguous or computed navigation is refused. The source transaction presents the MDX, example module, navigation, and manifest together for review before Save.

Components without both an exact usage snippet and an exact example module stay in the manifest and appear in `omissions`. The adapter does not manufacture a placeholder preview or inferred import.
