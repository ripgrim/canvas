# Sync Container architecture spike

This isolated spike exercises the control-plane contracts for a generation-scoped collaborative room. It does not deploy a Worker or Container and does not integrate with production code.

## Local simulated contract checks

- A room identity is `sync:<protocolEpoch>:<fileId>:<generationId>`. A stable file-only identity is rejected.
- The current generation is resolved before admission. A retired generation can never reopen or reacquire a lease.
- The coordinator accepts API-shaped admission metadata only. Each request carries a bounded opaque room capability, subject, owner or viewer role, access epoch, and fenced authority context. Document bytes are rejected.
- Admissions queue behind one Container start and a separate readiness gate.
- Cold-start failure receives a bounded number of attempts. Every successful start gets a settled destroy attempt, including the final readiness failure, before the failed generation retires so resolution can create a replacement. Cleanup failures are retained on the terminal error while TTL and fencing remain the safety fallback.
- The coordinator proxies accepted connections only after readiness. The bridge receives an `AbortSignal`, exposes an idempotent cancel handle, and has a bounded handshake deadline. A failed or timed-out proxy rejects that admission without dropping the next queue entry.
- A disconnect cancels exactly its queued admission. Cancellation aborts a never-settling proxy, disposes an upstream that resolves after cancellation, and cannot create a ghost active connection.
- The Container fake rejects viewer access to the editable room, stale access epochs and fences, and invalid capabilities. This models an enforcement boundary without proving the production authorization path.
- Connection identity is distinct from client identity and all identifiers are bounded.
- Reconnecting during the grace window cancels shutdown.
- Opening during drain is rejected with an instruction to resolve the current generation again.
- An idle room closes admission and operation gates, notifies clients to reconnect, waits for tracked commits, checkpoints, releases its lease, and exits.
- Atomic lease acquisition, TTL, renewal, expiry, monotonic fencing, idempotent release, permanent generation retirement, and fenced checkpoint pointers are modeled.
- A failed or timed-out checkpoint is not reported as a graceful stop. Forced termination leaves the lease for TTL-based crash recovery.
- Mutation handling calls the durable-log boundary before ACK and broadcast. Duplicate IDs receive an exact duplicate ACK only when a canonical content digest matches, and are never broadcast again. Changed content conflicts before ACK. The in-memory fake does not prove storage durability.
- Every phase event requires explicitly bounded string representations for app platform, app version, protocol epoch, generation, phase, and correlation or request reference, plus a positive safe-integer fence when authoritative. Error phases require a bounded string error code. Events are copied into an immutable scalar allowlist. Document, payload, operation, operation payload, source patch, cookie, ticket, credential, capability, token, and other secret-shaped fields are rejected recursively.
- A synthetic 50 MiB snapshot can pass through a fixed-size streaming loop without allocating a 50 MiB fixture or buffer. Both RSS delta and absolute RSS have failure thresholds.

The in-memory adapters are intentionally strict fakes. They prove ordering and contract behavior, not Cloudflare placement, cold-start latency, WebSocket behavior, or failure recovery on Cloudflare infrastructure.

## Commands

From this directory:

```powershell
npm run check
npm test
npm run memory
npm run verify
```

From the repository root:

```powershell
npm --prefix experiments/sync-container run verify
git diff --check -- experiments/sync-container
```

The memory harness defaults to a synthetic 50 MiB stream and fails if its measured RSS increase exceeds 64 MiB or absolute RSS exceeds 256 MiB:

```powershell
node experiments/sync-container/scripts/memory-harness.mjs --mib 50 --max-rss-delta-mib 64 --max-absolute-rss-mib 256
```

This cannot pass `CLOUD-SYNC-MEMORY-001`. It checks streaming overhead only and does not establish the memory required to hydrate or mutate a real 50 MiB document. Passing that acceptance test requires the production codec, Yjs document, indexes, checkpointing, concurrent clients, and selected Container size on Cloudflare.

## Cloudflare boundary

`CloudflareContainerAdapter` follows the direct Durable Object Container API documented on October 10, 2026:

- `ctx.container.running`
- `ctx.container.start(options)`
- `ctx.container.setInactivityTimeout(durationMs)`
- `ctx.container.getTcpPort(port).fetch(request)`
- `ctx.container.monitor()`
- `ctx.container.signal(15)` for `SIGTERM`
- `ctx.container.destroy(reason)` as a force-stop escape hatch

Cloudflare documents that `start()` returns before ports are ready. The injected `ready` function is therefore a required production adapter concern, not a no-op. The coordinator never sends admissions until it succeeds. A Durable Object constructor must call `restoreAfterDurableObjectRestart()` through `blockConcurrencyWhile` so an already-running Container receives a restored inactivity timeout and monitor.

`proxy()` requires an explicit WebSocket bridge with a keepalive interval. A bridge must convert a raw HTTP 101 response plus its WebSocket handle into a nominal verified-upgrade result with an idempotent disposer. `Response.ok` is deliberately ignored because it is false for status 101. The adapter fails when the bridge, upgrade handle, or disposer is absent. The coordinator disposes an established upstream if generation or fence validation changes during the proxy handshake. The spike does not pretend an HTTP `fetch()` alone proves WebSocket liveness, backpressure, or close propagation.

References:

- [Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/)
- [Container limits](https://developers.cloudflare.com/containers/platform/limits/)

## Platform verification checklist

These items remain unverified until a separately authorized Cloudflare deployment exists:

- [ ] Create two generation IDs for one file and confirm they map to distinct Durable Object and Container instances.
- [ ] Confirm the first opener controls initial regional placement and all clients for that generation reach the same active Container.
- [ ] Confirm a stopped generation can be replaced by a new generation near a later opener.
- [ ] Exercise concurrent cold admissions and verify the Container starts exactly once.
- [ ] Exhaust real cold-start retries and verify failed-generation retirement and replacement generation routing.
- [ ] Verify the readiness probe blocks HTTP and WebSocket proxying until the room process is listening and hydrated.
- [ ] Verify WebSocket upgrade, backpressure, disconnect, and reconnect behavior through `getTcpPort()`.
- [ ] Confirm the production WebSocket bridge honors handshake abort and timeout signals and closes any upstream created after cancellation.
- [ ] Disconnect while queued and during the real WebSocket proxy handshake, then confirm no ghost connection reaches the room process.
- [ ] Exercise production capability validation, viewer rejection on the editable channel, access revocation, and access-epoch rollover across the Worker-to-Container boundary.
- [ ] Kill a stale room after its lease is replaced and confirm PostgreSQL rejects its fenced append and checkpoint.
- [ ] Send `SIGTERM` and confirm the real process checkpoints and releases its lease before exiting.
- [ ] Race Container monitor settlement against graceful stop and confirm an exited process is never signaled.
- [ ] Force a host/container failure and confirm lease expiry and recovery do not produce split-brain writes.
- [ ] Confirm inactivity shutdown and reconnect-grace behavior with real Cloudflare lifecycle events.
- [ ] Run the production 50 MiB document fixture under load and record peak RSS, not just the streaming harness result.
- [ ] Confirm logs and traces carry correlation ID, room generation, fence, phase, and region without document contents or credentials.

## Acceptance-test mapping

These local simulations are evidence inputs only. They do not pass platform acceptance.

| Acceptance ID | Local evidence | Status |
| --- | --- | --- |
| `CLOUD-SYNC-CONTAINER-001` | Generation identity, cancellable queued admission, bounded proxy handshake, authority-shaped metadata, serialized lifecycle, direct API-shaped adapter | Not accepted; simulated only |
| `CLOUD-SYNC-LEASE-001` | TTL, renewal, expiry, fencing, retirement, fenced checkpoint, duplicate ACK without rebroadcast, canonical replay conflict, durable-log boundary call order | Not accepted; in-memory simulation only |
| `CLOUD-SYNC-DRAIN-001` | Grace cancellation, drain gates, tracked commits, reconnect notice, failed checkpoint, forced termination | Not accepted; simulated only |
| `CLOUD-SYNC-MEMORY-001` | Generated 50 MiB fixed-chunk streaming RSS harness | Not passed; insufficient test surface |
| `OBS-SYNC-001` | Immutable allowlisted events with application, room, authority, request, error, and recursive redaction contracts | Not accepted; in-memory recorder only |

## Deliberate omissions

- No Worker, Durable Object, Container image, database, R2 bucket, or deployment configuration is created.
- No document model or Yjs implementation is included.
- No permanent file-to-region pinning is modeled. A new activation must receive a new generation ID.
- No document body crosses or remains in the coordinator.
- The WebSocket bridge is a required injected boundary, not an implementation in this spike.
