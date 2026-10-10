# File assets Worker

This Worker keeps the R2 bucket private and exposes only file-scoped operations.
The hosted API is the authorization authority. Each request forwards the user's
session to `POST /internal/file-access`, together with a Worker-to-API service
token.

Assets use `<fileId>/<assetId>.<ext>`. File thumbnails use the stable
`thumbnails/<fileId>/thumbnail.avif` key used by the home screen. The thumbnail
route stores a pre-rendered AVIF. It does not render or convert images.

Uploads pass through the Worker. Cloudflare R2 presigned PUTs cannot enforce a
maximum body size, so the Worker checks the declared and received byte count
before Files SDK writes through the R2 binding.

Immutable asset creation and copy destinations use R2's `If-None-Match: *`
conditional binding write because Files SDK does not advertise conditional
operations for R2. This closes the destination race between the existence check
and storage. Reads, metadata, and mutable thumbnail writes continue through
Files SDK.

Required secrets are `UPLOAD_INTENT_SECRET` and `API_SERVICE_TOKEN`. Local
values belong in `.dev.vars`, which is not committed. `FILE_ASSETS` is the R2
binding and `API_ORIGIN` is a fixed hosted API origin.

R2 bindings have no native copy command, so copy reads the immutable source and
uses a conditional destination write inside the Worker. The client never
receives the source bytes. The destination creation is atomic even though the
two-object operation is not.
