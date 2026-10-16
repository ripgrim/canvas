# Component system v2

The editor has one component definition and one instance protocol. A definition may be authored on the canvas or supplied by a verified code binding. Canvas, code preview, documentation, and generated variant sheets resolve the same property schema rather than translating between separate models.

## Product boundary

Application preview and component authoring are separate features. An embedded application runtime may render the connected app on the canvas, but it does not establish component identity, editable properties, materials, slots, or source synchronization by itself.

The old Repository, Create component, and Source history inspector disclosures are removed. Repository discovery and the isolated React runtime remain infrastructure until account-aware project Sources replaces the local connection workflow.

## Definitions and instances

A component definition owns:

- a stable component ID independent from path, export name, and revision;
- a source discriminant for a canvas master or verified code binding;
- typed Variant, Text, Boolean, and Slot properties with stable IDs;
- component-local materials and stable part bindings;
- prototype interactions that reference property and value IDs;
- documentation metadata.

An instance stores its definition ID and scalar overrides. Slot contents remain document relationships. Defaults live on the definition, so changing one instance does not mutate the master or another instance.

Canvas definitions point at a real master subtree. Code definitions point at an opaque verified binding. Paths, source hashes, exports, credentials, and repository grants remain outside the persistent component identity.

## Materials

A material is a component-local appearance recipe grouped and named by the designer. Materials may reference file theme tokens. Parts bind to materials through stable IDs, allowing one material change to reach every bound part without changing literal, unbound parts.

Materials remain local by default. Promoting a material into a shared token or recipe is an explicit later action, not an implicit global mutation.

## Variants and interactions

Variant properties own ordered values and one default. A displayed variant is an authored view of the definition, not an independent copied component. The implementation stores one master plus sparse configuration changes rather than a full duplicated tree for every combination.

Prototype interactions set transient instance property values. They do not write the document on pointer entry or press.

## Documentation

Blume is the component documentation renderer. The editor emits a component manifest from the same definition used by the canvas. A Blume adapter can turn that manifest into:

- playground controls;
- a live example;
- a usage snippet;
- a bounded variant combination sheet;
- Open in canvas and Open source actions.

The current Comp Blume app reads MDX from `apps/docs/docs` and live examples from `apps/docs/registry/comp/**/examples/*`. For a connected repository that already contains a Blume app, its own configuration identifies those roots instead of the editor hardcoding the Comp paths. Generated content is prepared as a reviewed source transaction. The editor never guesses a docs layout or writes to a repository without explicit Save approval.

## Sources

Repository connection belongs to project Sources, not the selected-node inspector.

- GitHub uses the authenticated user's GitHub App installation and a server-checked repository grant.
- Local repository access is desktop-only and remains behind the narrow preload boundary.
- The renderer receives opaque source IDs, display metadata, verified component manifests, and capability state. It receives no token, cookie, arbitrary filesystem path, shell, or fetch primitive.

Component discovery stays static and does not run repository code. Preview compilation runs outside the privileged editor process on an isolated origin. Unsupported dynamic provenance remains unsupported until a verified adapter can describe it.

## Delivery order

1. Remove false component workflows and define the v2 domain contract.
2. Persist canvas definitions and component instances in the file schema.
3. Add canvas master creation, materials, parts, and typed properties.
4. Add slots, variants, and prototype transitions.
5. Adapt verified code bindings to the same definition and instance protocol.
6. Add project Sources backed by GitHub App grants and desktop local access.
7. Generate Blume manifests, playgrounds, snippets, and variant sheets.
8. Remove the legacy composition and promotion implementation after stored documents migrate.

The compatibility period is bounded to migration. No permanent dual component model is allowed.
