# Sync room core

`@canvas/sync-room-core` is the generation-scoped collaboration data plane. It owns one file generation at a time, verifies room capabilities, streams the current projection, serializes semantic operations, and acknowledges an operation only after the collaboration persistence layer records it.

The executable binds only to loopback. A routing layer will own public traffic, placement, admission queuing, and container activation. This package does not claim a Cloudflare deployment or placement strategy.

## Local multi-room host

Build the database and protocol packages before starting this package in a fresh workspace install.

Required environment variables:

- `DATABASE_URL`
- `ALLOWED_ORIGINS`
- `SYNC_ROOM_TICKET_SECRET`, a base64url value containing at least 32 bytes
- `SYNC_ROOM_CHECKPOINT_DIR`

Optional runtime values are:

- `PORT`, default `4325`
- `HOST`, default `127.0.0.1` and restricted to loopback
- `SYNC_ROOM_LEASE_DURATION_MS`, default `30000`
- `SYNC_ROOM_LEASE_RENEWAL_MS`, default `10000`
- `SYNC_ROOM_DRAIN_TIMEOUT_MS`, default `20000`
- `SYNC_MAX_MESSAGE_BYTES`, default `262144`
- `SYNC_HOST_MAX_ROOMS`, default `32`
- `SYNC_HOST_MAX_PENDING_UPGRADES`, default `64`
- `SYNC_ROOM_HANDSHAKE_TIMEOUT_MS`, default `5000`
- `SYNC_HOST_STARTUP_TIMEOUT_MS`, default `10000`
- `SYNC_HOST_SHUTDOWN_TIMEOUT_MS`, default `30000`

Start the host with:

```text
pnpm --filter @canvas/sync-room-core dev
```

The host does not require preconfigured file or generation IDs. It verifies a signed room ticket and current file access before lazily starting the exact requested room generation.
The ticket signature is verified once before room startup. The resulting one-use authorization is consumed inside serialized room admission, where current access and the browser build are rechecked immediately before snapshot delivery. Verified identity, role, access epoch, file, generation, build, and client claims are bound to the accepted server-side socket session; no ticket or client-controlled room authority is echoed in later WebSocket frames.

Consumed room-ticket nonces remain rejected for their validity window after a socket disconnect. The in-process ledger prunes expired entries and fails closed at 16,384 live entries. Production restart replay protection is owned by the coordinator Durable Object's persistent one-use admission ledger. The room runtime must remain private because an exact leaked room-internal ticket presented directly to a newly restarted runtime is outside that coordinator redemption boundary.

## Generation-scoped service

The production-shaped `start` command remains generation-scoped. It additionally requires `SYNC_ROOM_FILE_ID` and `SYNC_ROOM_GENERATION_ID`, and defaults `PORT` to `4322`.

Both services expose `GET /healthz`, `GET /readyz`, and a WebSocket upgrade at:

```text
/sync/:fileId/:generationId?clientId=:clientId&connectionNonce=:nonce
```

The upgrade requires an allowed `Origin` and `Authorization: Bearer <room-ticket>`. The ticket verifier checks signature, expiry, room scope, client identity, connection nonce, role, authorized build, and current access epoch.

## Verification

```text
pnpm --filter @canvas/sync-room-core test
pnpm --filter @canvas/sync-room-core typecheck
pnpm --filter @canvas/sync-room-core build
```

The focused suite provides local contract evidence toward `DEV-STACK-001`, `CLOUD-SYNC-CONTAINER-001`, `CLOUD-SYNC-DRAIN-001`, `CLOUD-SYNC-MEMORY-001`, and `CLOUD-SYNC-REPLAY-001`. It does not close deployment-level acceptance tests. Platform placement, reconnect replay against PostgreSQL, process-kill recovery, live presence, and full-pipeline peak memory remain open.
