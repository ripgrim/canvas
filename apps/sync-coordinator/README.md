# Sync Coordinator

Private generation coordinator and Durable Object boundary for collaboration protocol epoch 2. It accepts only signed admission envelopes from the public sync Worker, selects the server-provided generation object, mints the scoped room ticket, and proxies a sanitized RFC6455 upgrade to one running room runtime.

Each signed Worker envelope contains a unique admission ID. The generation-scoped Durable Object atomically records that ID before minting a room ticket, so the same capability cannot mint another nonce after disconnect or after the Durable Object is evicted and recreated. The persistent replay ledger retains entries through their short validity window and removes at most 64 expired entries on each successful redemption, keeping cleanup work bounded. A reconnect obtains a new admission from the public Worker.

The admitted browser build is carried through the signed Worker envelope and room ticket. The room runtime compares it with `room.open.buildId` before sending a snapshot.

The environment intentionally has no API admission token, browser session authority, database URL, repository credential, or source credential.

Hosted configuration is intentionally absent. `workers_dev` is disabled and no routes or hosted environments are declared. A production deployment remains unsupported until a Container manager provides generation start, health, convergence, drain, and stop. Local development uses `SYNC_ROOM_RUNTIME_ORIGIN=http://127.0.0.1:4325`.
