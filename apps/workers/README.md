# File assets Worker

This Worker keeps the R2 bucket private and exposes only file-scoped operations.
The hosted API is the authorization authority. Each request forwards the user's
session to `POST /internal/file-access`, together with a Worker-to-API service
token.

Assets use `<fileId>/<assetId>.<ext>`. Thumbnail objects use immutable
`thumbnails/<fileId>/versions/<revision>/<nonce>.avif` keys. The Paper-shaped
stable URL `/file-assets/thumbnails/<fileId>/thumbnail.avif` is a private
resolver, not an object key. It serves only the exact key and ETag committed for
the file's current revision.

Thumbnail writes require `POST /file-assets/thumbnail-upload-intents` followed
by `PUT /file-assets/thumbnail-uploads`. The signed intent binds the user, file,
expected file revision, media type, byte count, nonce, expiry, and versioned
object key. The upload consumes a create-only nonce marker before atomically
creating the immutable object. A replay cannot replace an object, and an upload
that loses revision authorization does not consume its nonce. Configure an R2
lifecycle rule to expire
`thumbnail-claims/` markers after the longest audit window required by the
service.

For thumbnail intent creation and upload, the Worker sends
`{ fileId, access: "write", expectedRevision, resource: "thumbnail" }` to
`POST /internal/file-access`. The API must compare `expectedRevision` to the
current file head and return exactly `{ userId, revision }` with the matching
revision. A response without that revision fails closed. Non-thumbnail access
continues to use `{ fileId, access }` and the exact `{ userId }` response.
Stable thumbnail reads send `{ fileId, access: "read", resource: "thumbnail" }`.
The API returns exactly
`{ userId, revision, thumbnailKey, thumbnailEtag }`, with key and ETag both null
when no thumbnail is committed. The Worker verifies the version key, object
ETag, content type, file metadata, and revision before returning bytes.

Uploads pass through the Worker. Cloudflare R2 presigned PUTs cannot enforce a
maximum body size, so the Worker checks the declared and received byte count
before Files SDK writes through the R2 binding.

Media validation starts with bounded structural parsing, not a magic-byte check. PNG uploads require a
complete, CRC-valid chunk stream through `IEND`. JPEG uploads require a frame,
scan, and terminal `EOI`; GIF uploads require a complete image-data block and
trailer; and WebP uploads require an exact RIFF length and a structurally valid
image chunk. Thumbnail AVIF uploads additionally require a coherent primary
`av01` item: `pitm`, `iinf`, `iloc`, `ipma`, `ispe`, and `av1C` must agree, every
primary extent must lie inside `mdat`, and the extent bytes must contain a
bounded AV1 OBU sequence with a sequence header and frame. This rejects
truncated media and AVIF files assembled from plausible boxes that do not
describe a complete primary image. Structure is not treated as proof that image
codecs can decode pixels. PNG, JPEG, WebP, and AVIF bytes are then decoded by
published pixel decoders, and GIF frames are fully decoded, before any object
write. Decoder errors, container-to-decoder dimension mismatches, or a decoded
pixel budget above 16 MiPixels return `415`.

Immutable asset creation and copy destinations use R2's `If-None-Match: *`
conditional binding write because Files SDK does not advertise conditional
operations for R2. This closes the destination race between the existence check
and storage. Reads and metadata continue through Files SDK. Immutable thumbnail
versions use the same conditional R2 binding write.

Thumbnail intent issuance and upload attempts are separately bounded with
storage-backed fixed-window quota slots. Upload-attempt quota is acquired after
the signed intent and service authorization are checked but before
`Content-Length`, body streaming, structural validation, or pixel decode.
The defaults allow 60 uploads per authenticated user and 20 uploads per file
per minute. Each successful reservation creates one immutable
`thumbnail-quota/<window>/<scope-hash>/<slot>` marker with its expiry in custom
metadata. Create-only slot claims provide a hard upper bound across Worker
isolates. Contention can reject conservatively, and a failed file reservation
can consume a user slot until the minute ends. This is intentional fail-closed
behavior.

Thumbnail mutation routes do not accept an end-user session. They require
`X-Canvas-Thumbnail-Service-Token`, which the Worker forwards only to
`POST /internal/thumbnail-upload-access` together with its own API service
credential and `{ fileId, expectedRevision }`. The API response is restricted
to `{ serviceId, revision }`. User authorization and broader asset operations
remain on the separate file-access contract.

The hourly Wrangler scheduled trigger runs `ThumbnailGarbageCollector` with a
resolver that reads the currently committed thumbnail key and ETag from the
hosted database. Each collector call scans one bounded page and deletes at most
100 objects by default. The scheduled handler follows the returned phase and
cursor continuation for at most 12 pages per invocation, so later eligible
objects are reached without giving one cron event unbounded work. The default
policy is:

- keep the exact committed key regardless of age;
- keep uncommitted or failed generations for a 24-hour investigation grace;
- keep superseded generations for seven days;
- remove replay claim markers after seven days;
- remove quota markers after their recorded window expiry.

R2 does not offer conditional delete. Cleanup therefore fails closed when list
metadata has no ETag, protects the database-committed key, and only deletes
aged nonce-bearing keys that were created with `If-None-Match: *` and can never
be replaced or reused. The delete itself is unconditional and is not described
as atomic. The commit resolver remains authoritative, and current keys are
never cleanup candidates.
Configure matching R2 lifecycle rules for `thumbnail-claims/` and
`thumbnail-quota/` as a fallback, with retention no shorter than these service
windows. Do not apply a broad lifecycle rule to `thumbnails/`; superseded and
uncommitted versions require the database-aware collector.

Required secrets are `UPLOAD_INTENT_SECRET`, `API_SERVICE_TOKEN`, and
`HOSTED_PREVIEW_WRITE_SECRET`. Local
values belong in `.dev.vars`, which is not committed. `FILE_ASSETS` is the R2
binding and `API_ORIGIN` is a fixed hosted API origin.

The checked-in Cloudflare resource manifest is
`deploy/cloudflare-r2.json`. The top-level Wrangler binding always uses local
R2 simulation. `wrangler dev -e preview` is the only configuration that opts
into the remote development bucket. The production environment names a
separate bucket so preview data can never become production data by changing a
flag.

Run `pnpm cloudflare:check` to verify the authenticated account, bucket
placement, storage class, direct-access settings, and managed lifecycle rules.
Run `pnpm cloudflare:setup` to create or reconcile the preview bucket without
deploying the Worker or uploading objects. Production is intentionally an
explicit future action:

```sh
node scripts/cloudflare-r2.mjs --environment production --apply
```

The setup command disables the public `r2.dev` URL and refuses to proceed when
a custom domain is attached. It manages only the two named thumbnail marker
rules and leaves Cloudflare's default incomplete-multipart rule intact.

R2 bindings have no native copy command, so copy reads the immutable source and
uses a conditional destination write inside the Worker. The client never
receives the source bytes. The destination creation is atomic even though the
two-object operation is not.
