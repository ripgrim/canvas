# Sync Coordinator

Private generation coordinator and Durable Object boundary for collaboration protocol epoch 2. It accepts only signed admission envelopes from the public sync Worker, selects the server-provided generation object, mints the scoped room ticket, and proxies a sanitized RFC6455 upgrade to the generation's room Container.

Each signed Worker envelope contains a unique admission ID. The generation-scoped Durable Object atomically records that ID before minting a room ticket, so the same capability cannot mint another nonce after disconnect or after the Durable Object is evicted and recreated. The persistent replay ledger retains entries through their short validity window and removes at most 64 expired entries on each successful redemption, keeping cleanup work bounded. A reconnect obtains a new admission from the public Worker.

The admitted browser build is carried through the signed Worker envelope and room ticket. The room runtime compares it with `room.open.buildId` before sending a snapshot.

The environment intentionally has no API admission token, browser session authority, repository credential, or source credential. The generation object passes only the database URL, room-ticket secret, and allowed origins into its private Container.

The staging coordinator has no public route. The public sync Worker reaches its generation class through a cross-script Durable Object binding. Keeping the replay ledger, Container lifecycle, and WebSocket upgrade in one generation object avoids relaying upgraded sockets through an intermediate Worker. No production environment is declared. Local development uses `SYNC_ROOM_RUNTIME_ORIGIN=http://127.0.0.1:4325`.
