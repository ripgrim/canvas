# Thumbnail jobs

This private Node service follows the Paper split between an isolated `/thumbnail-renderer` browser surface and a headless capture worker. It reads an exact file revision through the internal API, injects that source before navigation, waits for the renderer readiness contract, captures a fixed 1024×768 viewport, encodes AVIF, uploads through the private assets Worker, and commits the exact object key and ETag with a revision CAS.

It holds only dedicated service credentials. The renderer receives no credentials, cookie, filesystem capability, or arbitrary fetch bridge.

Local port: `4324`. The service continuously claims revision-bound jobs from the API queue. The authenticated `POST /internal/thumbnail-jobs` route remains available for a one-off diagnostic capture.
