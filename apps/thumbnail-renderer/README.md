# Thumbnail renderer

This isolated browser app renders one injected, revision-bound file source at `/thumbnail-renderer`. It follows the Paper runtime contract recovered from its public web bundle:

- no editor panels, labels, guides, selection chrome, or progressive mounts;
- content fitted into a fixed capture viewport;
- three animation frames of settling before readiness;
- `window.__PAPER_THUMBNAIL_READY` plus `paperThumbnailReady`, `paperThumbnailPhase`, `paperThumbnailFileId`, and `paperThumbnailError` document markers.

The capture job injects the source before navigation. `CANVAS_VERIFIED_COMPONENT_REGISTRY` may point to a generated registry manifest at build or local start time. The same manifest contract drives the editor preview and this renderer, including exact component exports, styles, provider, theme adapters, declared fonts, and declared assets. Missing and mismatched component identities fail before capture instead of producing a substitute shell.

The renderer has no API credentials, session cookie, filesystem bridge, or source-writing capability. Registry verification reads declared files, checks their integrity and export names, and rejects privileged imports. It does not load repository configuration, install dependencies, or run repository scripts.

Local URL: `http://127.0.0.1:4323/thumbnail-renderer`
