# Sync Worker

Public collaboration admission edge for protocol epoch 2. It validates a complete RFC6455 request, exchanges the browser session with the API admission endpoint, signs a short-lived internal admission envelope, and forwards the upgrade through the private `SYNC_COORDINATOR` service binding.

This process holds the dedicated API admission token. It does not hold the room-ticket secret, runtime address, database URL, repository credential, or source credential. Browser credentials are removed before crossing the coordinator boundary.

Hosted configuration is intentionally absent. `workers_dev` is disabled and no routes or hosted environments are declared. Production remains unsupported until the separate coordinator has a real Container manager. Local development requires the coordinator service plus `.dev.vars` values for `COLLABORATION_ADMISSION_SERVICE_TOKEN` and `SYNC_COORDINATOR_INTERNAL_SECRET`.

Focused coverage contributes to `CLOUD-SYNC-AUTH-001`, `CLOUD-SYNC-DO-001`, and `CLOUD-SYNC-DO-SEC-001`.
