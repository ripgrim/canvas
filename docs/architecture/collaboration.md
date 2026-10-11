# Collaboration

The collaboration system keeps one authoritative live room per file while clients retain enough local state to open quickly, work offline, and recover without losing acknowledged or queued edits.

## Evidence labels

This specification distinguishes observed behavior from architecture decisions.

- `[REPO]` describes current Design editor source, tests, or limits.
- `[WONDER BUNDLE]` describes behavior found in the preserved public Wonder client bundle. It does not prove Wonder's server topology.
- `[PAPER BUNDLE]` describes behavior found in Paper's public production client bundle. It does not prove Paper's private server topology.
- `[PAPER EVIDENCE]` describes observed Paper behavior or the Paper implementation details supplied by the user. It is not an independent audit of Paper's private infrastructure.
- `[PLATFORM]` describes behavior documented by the current platform vendor.
- `[DECISION]` defines the Design editor architecture.

## Goals

- Keep one authoritative active room for each file.
- Place each cold room near its first opener and keep that generation pinned while it is active.
- Let a later cold generation relocate instead of binding the file to one region forever.
- Show cached work quickly without exposing another account's private file.
- Persist local edits before transmission and replay them idempotently after disconnects.
- Enforce file roles, share state, generation ownership, and revocation on the server.
- Support large documents through streamed snapshots, bounded updates, and external assets.
- Preserve the existing source-review and multi-file Save transaction as a separate trust boundary.

## Non-goals

- Do not make R2 the room registry, revision allocator, or session store.
- Do not keep a permanent file-scoped Durable Object.
- Do not run PostgreSQL or R2 writes directly from the browser or Electron renderer.
- Do not use generic JSON paths or unrestricted client-generated Yjs updates as the authoritative write protocol.
- Do not treat an iframe, a WebSocket, or an encrypted client payload as authorization.
- Do not infer live anonymous sharing from the current signed-in read-only share flow.

## Keep one data authority

`[REPO]` The current sync protocol sends revisioned `set`, `delete`, and `splice` edits. PostgreSQL applies each batch to a cloned `FileDocument`, validates the complete result, writes the full JSON document, and appends the batch. The browser can also fall back to a revision-checked HTTP write.

`[DECISION]` Replace generic paths and dual HTTP/WebSocket writes with typed semantic operations. A room orders, validates, persists, acknowledges, and broadcasts every operation. PostgreSQL stores the durable operation log and validated document checkpoints. The active Container holds the current validated document in memory.

Use stable identifiers for every operation:

```text
fileId
clientId
clientMutationId
operationType
operationPayload
protocolEpoch
roomGeneration
```

Persist an operation before acknowledging it. Replaying the same `clientMutationId` must return the first committed result. Reusing an identifier with different content must fail.

### Yjs and Hocuspocus

`[WONDER BUNDLE]` Wonder uses Yjs, a Hocuspocus provider, cached document state, pending-update replay, awareness, and explicit queued, stream, and apply phases.

`[DECISION]` Copy the recovery model, not an unrestricted update channel. The initial architecture uses typed semantic operations because Design editor must validate component identity, relationships, tokens, document limits, and source bindings before mutation.

Do not run Yjs and the revisioned JSON document as two writable authorities. If a later spike adopts Yjs:

- replace the live-state persistence path instead of adding a second one;
- accept only server-validated semantic commands as write intent;
- let the room emit authoritative Yjs updates and state vectors;
- store binary snapshots and updates without a JSON round trip;
- keep the validated `FileDocument` projection as a read, export, and thumbnail model;
- keep media assets outside the Y.Doc;
- use local transaction origins so one user cannot undo another user's edit.

Source writes remain separate. Include the collaborative checkpoint or state-vector hash in a source review. Any remote document change invalidates approval and requires a new diff.

## Client state machine

Keep internal phases precise and user-facing copy short.

| State | Entry condition | Exit condition | Visible copy |
| --- | --- | --- | --- |
| `cold` | No trusted file state is selected. | Opening begins. | None |
| `opening` | Cache lookup and session resolution start. | Authorization is known. | `Opening file…` |
| `authorizing` | The account, offline grant, and file access are checked. | Access is granted, read-only, denied, or unavailable. | `Opening file…` |
| `hydrating-local` | A valid account-scoped cache is available. | The local snapshot is validated and published. | `Opening file…` |
| `admission-queued` | The Worker accepted the request while the room starts or waits for capacity. | Admission succeeds or fails. | `Connecting…` |
| `streaming` | The client receives a checkpoint or missing update chunks. | All expected chunks arrive and verify. | `Opening file…` |
| `applying` | Received state is validated in staging. | One complete snapshot is published. | `Opening file…` |
| `live` | The client is caught up with write access. | Disconnect, role change, drain, park, or close. | None |
| `read-only` | The client has a viewer grant. | Disconnect, revocation, drain, or close. | `Read only` |
| `offline-clean` | The cache is current and no local operation is pending. | Reconnect, edit, or close. | `Offline` |
| `offline-dirty` | At least one local operation is durably queued. | Reconnect, revocation, or close. | `Offline` |
| `reconnecting` | Transport or room ownership changed. | Admission resumes or a terminal state is reached. | `Reconnecting…` |
| `replaying` | Durable local operations are sent in original order. | Every operation is acknowledged or rejected. | `Saving changes…` |
| `access-revoked` | A prior grant no longer permits the file. | The user leaves or exports local work. | `Access removed` |
| `incompatible-build` | The protocol or document cannot migrate safely in this build. | The app updates or closes the file. | `Update required` |
| `capacity-refused` | The room cannot start after bounded retries. | The user retries or leaves. | `File is busy` |
| `draining` | The active generation is stopping. | A new admission begins. | `Reconnecting…` |
| `parked` | A hidden idle client closed its socket after local persistence completed. | Visibility or an edit resumes the connection. | None |
| `closing` | Local persistence and owned service disposal run. | Disposal completes. | None |
| `closed` | Sockets, timers, subscriptions, and owned resources are gone. | A new file session starts. | None |

Use this transition order for a normal open:

```text
cold
  -> opening
  -> authorizing
  -> hydrating-local
  -> admission-queued
  -> streaming
  -> applying
  -> live | read-only
```

Reconnect through authorization and admission before replay:

```text
offline-clean | offline-dirty
  -> reconnecting
  -> authorizing
  -> admission-queued
  -> streaming
  -> applying
  -> replaying
  -> live
```

Persist each local operation in IndexedDB before sending it. Remove it only after the authoritative acknowledgement. Stage streamed state away from the visible document and publish it atomically.

### Editor command handoff

`[REPO]` The editor already applies typed `FileCommand` values locally, but the current browser adapter receives only the resulting `FileDocument`. It then reconstructs generic JSON edits and may fall back to an HTTP whole-document write. That adapter is not eligible for the collaboration test gate.

`[DECISION]` Carry the exact committed command or batch from the document store into the persistence boundary. Preserve command order while a save is in flight. Do not infer commands by diffing two documents. Undo and redo must produce an explicit typed inverse, or a separately validated server command, before they can use the live room. A whole-document fallback must never remain available after collaboration bootstrap.

The client may optimistically render a local command, but it removes that command from its durable queue only after the matching mutation identifier is acknowledged. A rejected command rolls back or rebases through the documented conflict path. It does not silently write the optimistic document through HTTP.

## Cache and privacy

Partition every browser cache entry by account, file, document schema, and protocol epoch. Store the last validated checkpoint, its sequence, pending semantic operations, and their mutation identifiers.

Do not reveal cached private content until the current session or an explicit unexpired offline grant authorizes that account and file. Purge or cryptographically seal private entries on sign-out, account change, and revocation. Treat browser-profile access to IndexedDB as a product-security decision that must be documented before offline private files ship.

Keep desktop account tokens and cache keys in Electron main. Expose only typed file operations and short-lived room tickets through preload. Never expose the auth client, arbitrary fetch, cookies, filesystem primitives, or encryption keys to the renderer.

When access is revoked with pending work, stop transmission and preserve the local queue for an explicit export or copy action. Do not silently discard it or continue writing to the file.

## Server topology

```text
Web or desktop
      |
      v
Cloudflare Worker
      |
      v
Generation Durable Object
      |
      v
Regional Container
      |
      +--> PostgreSQL
      +--> private R2
```

### Worker

The Worker owns:

- exact-origin and WebSocket upgrade validation;
- session extraction or a one-time room-ticket exchange;
- initial file and share authorization;
- active-generation resolution;
- cold-generation creation;
- routing to the selected generation DO;
- request and connection correlation identifiers.

The Worker does not retain document bytes, order edits, or own long-lived room state.

### Generation Durable Object

Use `sync:<protocolEpoch>:<fileId>:<generationId>` as the room-control identity. A new cold activation gets a new generation. This prevents one file from remaining permanently attached to the region of its first-ever Durable Object.

The generation DO owns:

- Container start, health, proxy, drain, and stop;
- admission while the Container starts;
- short-lived connection capabilities;
- cached lease and generation metadata;
- bounded startup retries.

It does not own the document, durable operation log, file policy, or cross-generation truth.

### Container

The Container owns the one authoritative active room for its generation:

- connected clients and awareness;
- operation validation and total ordering;
- the current validated document;
- durable append before acknowledgement;
- update broadcast;
- checkpoint scheduling;
- drain behavior.

Suppress awareness traffic when only one client is present. Do not create a separate single-player server mode.

### PostgreSQL

PostgreSQL owns:

- users, sessions, ownership, collaborators, and share policy;
- active room lease and monotonic fencing token;
- generation and compatibility metadata;
- append-only authoritative operations and idempotency records;
- validated document projection and checkpoint pointer.

Every durable append and checkpoint-pointer update must include the active fencing token in its predicate.

### R2

Private R2 stores immutable compressed checkpoints, media assets, thumbnails, and optional compacted operation segments. Upload a new object, verify its digest, then atomically advance the PostgreSQL pointer. Never mutate a referenced checkpoint in place.

R2 does not own leases, sessions, roles, revision allocation, or mutable room discovery.

## Presence and following

`[PAPER BUNDLE]` The parity reference for this section is `https://app.paper.design/assets/main-CkqFojyn.js`, captured 2026-10-10 as 4,043,039 bytes with SHA-256 `9F54B8F57C1B043FD7F0AB5B74B6AB2242DD2FA28461DBD0D109BF3E157F7BEA`. Re-audit this behavior when Paper's production asset name or digest changes.

Presence is ephemeral room state. It is never part of the durable operation log, document projection, checkpoint, undo history, or source review. The room publishes an initial roster, one join event, monotonic awareness updates, and one leave event for each connection. Reject stale sequences, cross-file or cross-generation updates, malformed fields, and oversized payloads before broadcast.

The first multiplayer transition publishes the complete local awareness state once. After that, publish only changed fields and cap cursor and camera traffic at roughly 33 Hz. Suppress routine page, focus, selection, camera, and cursor traffic while the room has one writable participant. A signed-in `viewer` may receive roster and awareness state but sends no awareness frames in the first read-only slice.

`[PAPER BUNDLE]` The editor header renders the local person first, then deduplicated active agents, then remote people in roster insertion order. Headless sessions stay out of the strip. Paper shows up to two agent identities and four remote people before overflow, and collapses only when at least two identities would be hidden, so exactly one extra identity remains visible. Human avatars are 22 px circles with 4 px overlap and a 2 px panel-surface outline. They use the account image or uppercase initial, the collaborator name as the tooltip, and `<name> (you)` for the local identity. Agent marks are 14 px inside the same 22 px footprint. Excess agents precede excess people in the count-only trigger that opens an identity roster. Access does not change the human identity treatment: a viewer uses the same avatar, not a separate viewer icon.

`[DECISION]` Match that ordering, density, sizing, tooltip copy, and overflow behavior with the active Wonder theme. Collaborator colors identify people without replacing shared surface tokens. Do not invent a viewer or spectator badge.

`[PAPER BUNDLE]` Clicking a remote person starts `following`, not `watching`. Paper hides both panels, tracks the person's page and camera, renders a 10 px solid boundary in the followed person's stable color, and uses the exact labels `following {name}` and `stop following`. The captured bundle contains no `watching` label for this path.

`[DECISION]` Match that interaction and copy. Stop following on local pan or zoom, explicit stop, participant departure, generation replacement, room switch, or disposal, then restore the prior panel state.

Render remote cursors and selections only on the active page. Assign color deterministically from the stable user identity. Match Paper's 8 px cursor dot and adjacent name pill. When the remote editor is blurred, append the existing 16 px eye-off icon to that name pill, reduce the cursor to 80% opacity, and reduce selection emphasis to 25% alpha. The eye-off mark describes current focus only; it is not an access-role or viewer badge. Interpolate ordinary cursor movement, snap implausibly large deltas, disable decorative motion when reduced motion is requested, and never delay local input to smooth a remote cursor.

Remote cursors and 2 px selection union boxes render only on the active page. Cursor motion interpolates halfway toward the next point and snaps when a coordinate delta exceeds 1,000 px, when the participant is followed, or on the first sample. A blurred participant's cursor uses 80% opacity and selection uses 25% alpha. Respect reduced-motion preferences even though Paper's current path does not. Join and leave update the roster without a toast. Collaboration services own socket and pointer subscriptions through explicit `start`, `stop`, and `dispose` methods. React reads stable cached snapshots through `useSyncExternalStore`; no effect hook owns collaboration lifecycle.

## Room lifecycle

1. **Resolve.** The Worker reads the current lease through a server-only control path.
2. **Place.** If no lease is active, the first opener creates a random generation and contacts its new generation DO from the nearest Worker edge.
3. **Acquire.** The Container atomically claims the file lease. PostgreSQL issues a monotonic fence. Competing candidates stop and route clients to the winner.
4. **Hydrate.** Stream the checkpoint from R2, verify its digest and schema, then replay PostgreSQL operations after the checkpoint sequence.
5. **Serve.** Validate the connection capability, file role, generation, fence, protocol, schema, and operation before mutation. Append durably, then acknowledge and broadcast.
6. **Renew.** Renew before the lease TTL expires. Stop acknowledgements and enter drain when renewal fails.
7. **Grace.** Keep an empty room alive for a configurable reconnect window. Measure the initial value instead of hard-coding it into the protocol.
8. **Checkpoint.** Trigger by elapsed time, operation count, and byte volume. Advance the pointer only after the immutable object verifies.
9. **Release.** After grace, drain, checkpoint, release the lease, and stop. A later opener creates a relocatable generation.
10. **Recover.** After a crash, let the lease expire, issue a higher fence, load the last committed checkpoint, replay the log, and accept idempotent client replay.

On `SIGTERM`, stop admission, notify clients to reconnect, reject new operations, finish committed writes, checkpoint if the remaining budget permits, release the lease, and exit. Continuous append durability is required because termination may occur without a useful drain window.

## Read-only sharing

A signed-in non-owner with an active link-view grant may join the live room as `viewer`. The room sends checkpoints and ordered updates but rejects every mutation before it reaches the document. The room ticket binds the user, file, role, generation, protocol epoch, and expiry.

Opening Share or copying a link does not change access. Revocation closes or downgrades existing viewer connections and prevents reconnect. Private and nonexistent files keep the same not-found response.

Anonymous live links, editor roles beyond owner/viewer, and offline access for shared viewers remain separate product decisions.

Render a viewer in the regular editor shell, not a separate static preview. Hide the right inspector plus repository, source, and mutation controls. Keep navigation and explicitly approved view interactions. Show the dismissible notice `You can only view this file` with `To edit, ask the owner to add you as an editor`. Server authorization remains authoritative even when controls are hidden.

## Large documents

`[REPO]` The current `FileDocument` limit is 4,000,000 serialized characters, embedded assets are limited to 64 entries and 1.5 MB each, and the hosted document write body is limited to 5 MB. A 50 MB document is not currently supported.

Before raising that limit:

- move media bytes to R2 and store immutable asset references in the document;
- stream compressed checkpoints instead of buffering multiple complete copies;
- bound compressed size, decompressed size, update size, batch size, node count, and nesting independently;
- replace full-document undo snapshots and full-document equality serialization;
- remove full-document clones from the edit hot path;
- measure load, edit, replay, validation, and checkpoint peak memory with a real 50 MB fixture;
- run compaction in a separate job or Container when it would require a second full live document.

Choose the Container memory class only after the platform spike measures peak resident memory. Keep a safety margin for runtime overhead, indexes, WebSocket buffers, and validation staging.

## Authorization

Authorize every join through the Worker and API control plane. Issue a short-lived capability bound to the exact user or share subject, file, role, generation, protocol epoch, and expiry.

Authorize every update in the Container against that capability, the current role and revocation epoch, and the active fencing token. A capability avoids a central database query for every pointer move, but it does not bypass server enforcement. Refresh or terminate it when the access epoch changes.

Keep database, service, lease, signing, and R2 credentials server-side. The client never chooses its generation, region, role, revision, or fence.

## Errors and telemetry

Carry one correlation chain across the Worker, generation DO, Container, PostgreSQL transaction, client state, toast, and operational log:

```text
request_id
connection_id
client_mutation_id
file_id
room_generation
fence_token
protocol_epoch
app_platform
app_version
phase
error_code
```

Do not log document content, operation payloads, cookies, room tickets, source patches, or credentials. Hash or redact file identity in third-party analytics when direct identity is unnecessary.

Record named phase transitions and outcomes. Do not invent percentages. Suggested events are `sync_phase_entered`, `sync_cache_hydrated`, `sync_admission_queued`, `sync_room_started`, `sync_snapshot_streamed`, `sync_replay_started`, `sync_replay_completed`, `sync_room_draining`, `sync_checkpoint_completed`, `sync_lease_lost`, and `sync_operation_failed`.

Map failures to one durable state and at most one toast per error episode:

| Failure | Durable state | Toast behavior |
| --- | --- | --- |
| Short disconnect | `Reconnecting…` | Show only if prolonged. |
| Offline with queued work | `Offline` | Do not repeat. |
| Revoked access | `Access removed` | Show once with the server reference. |
| Incompatible protocol or schema | `Update required` | Keep the recovery action visible. |
| Capacity failure | `File is busy` | Offer `Try again`. |
| Corrupt local cache | Continue with server load. | Report that the local copy could not be opened. |
| Rejected operation | Stay live and roll back that operation. | Name the failed action. |
| Lease or persistence loss | `Reconnecting…` | Show once when local work remains queued. |

Server failures return a safe message, stable error code, and the same request reference written to operational logs. Generate a client-only reference only for errors that never crossed a server boundary.

## Local topology

Run every required service from the root development command:

| Port | Service |
| --- | --- |
| `4317` | Web editor |
| `4318` | Preview |
| `4319` | Login |
| `4320` | API |
| `4321` | Public sync Worker |
| `4322` | Assets Worker |
| `4323` | Thumbnail renderer |
| `4324` | Thumbnail jobs |
| `4325` | Container-compatible room runtime |
| `4326` | Private sync coordinator and DO emulator |

Start the room runtime before the sync readiness check succeeds. Point the local DO adapter at `http://127.0.0.1:4325`. Verify one real join, operation, acknowledgement, reconnect, and replay path. Shut down every child process and full process tree.

Run a Docker parity smoke against the same Linux image intended for Cloudflare Containers.

## Testing ladder

Do not ask people to judge collaboration from the editor until the local service chain owns one complete write path. Validate each boundary in dependency order:

1. **Contracts.** Run protocol and client state tests. Corrupt envelopes, stale generations, invalid roles, out-of-order chunks, and changed-content mutation replays must fail without publishing a document.
2. **Persistence.** Run the disposable PostgreSQL suite. Race lease candidates, bootstrap against legacy save, append against checkpoint, and bootstrap against prune. Prove append and projection update roll back together.
3. **Room runtime.** Start the room service on `4325` with PostgreSQL and an in-memory object adapter. Join two sockets, submit one semantic operation, observe append before acknowledgement, disconnect, reconnect, and replay the same mutation identifier.
4. **Worker path.** Start the public Worker on `4321` and private coordinator and DO emulator on `4326`. Connect only through the public Worker. Verify generation assignment, admission credential isolation, room-ticket isolation, capability binding, and proxy teardown.
5. **Client path.** Drive the browser transport through open, admission, snapshot staging, atomic publication, exact editor-command handoff, live operation, offline queue, reconnect, and replay. Prove that commands arriving during an in-flight acknowledgement retain their original order. The generic JSON-diff and HTTP document-save paths must be unavailable after collaboration bootstrap.
6. **Editor path.** Run two authenticated browser contexts against the root development stack. Edit in one, observe the other, reload both, revoke viewer access, and verify the stored projection independently through the API.
7. **Fault path.** Kill the room process after an acknowledged append, during an unacknowledged append, during checkpoint upload, and during drain. Every acknowledged operation must recover. Every unacknowledged local operation must remain queued.
8. **Platform spike.** Only after the local chain passes, run the Cloudflare placement, relocation, startup, memory, cost, and termination gates. This is the first test that can validate regional claims.

The first useful hands-on milestone is stage 6. Before then, use the focused suites as engineering evidence and do not present collaboration as ready for product testing.

## Production topology

Deploy the sync Worker, generation DO, and Container definition as one Cloudflare sync application. Keep the editor, login, API, and thumbnail HTTP surfaces in their existing hosted projects. Use PostgreSQL as the central durable authority and private R2 for immutable objects.

Expose only `VITE_SYNC_ORIGIN` to browser code. Keep these values server-side:

```text
SYNC_PROTOCOL_EPOCH
SYNC_CONTAINER_IMAGE
SYNC_CONTAINER_INSTANCE
SYNC_IDLE_TIMEOUT_SECONDS
SYNC_RECONNECT_GRACE_SECONDS
SYNC_LEASE_TTL_SECONDS
SYNC_GRANT_SIGNING_KEY
SYNC_MAX_MESSAGE_BYTES
SYNC_MAX_SNAPSHOT_BYTES
API_SERVICE_TOKEN
DATABASE_URL or Hyperdrive binding
R2 bindings
```

## Migration

Implement the architecture in dependency order with disjoint ownership:

1. Prove the platform behavior in an isolated spike.
2. Define semantic operations, states, errors, generation, fencing, and compatibility in `packages/sync-protocol`.
3. Add lease, operation-log, idempotency, and checkpoint-pointer persistence.
4. Build the Container room runtime without changing client or Worker files.
5. Reduce `apps/sync-worker` to generation admission and lifecycle control.
6. Add account-scoped cache, durable queue, atomic apply, replay, and parking to the client.
7. Replace web and desktop dual-write adapters with room tickets and the single live write path.
8. Connect editor status and toast presentation without adding effects.
9. Add the room runtime to root development and production checks.
10. Run independent security and acceptance review.

Do not let two implementation agents edit the same files concurrently. Give security-sensitive Worker, persistence, sharing, and desktop boundaries an independent review owner.

## Platform spike gate

Do not wire the Container architecture into production until an isolated Cloudflare spike proves all of the following:

- a cold generation can be placed from the first opener's request path;
- a stopped file can create a later generation in a different region;
- the Worker can resolve an active generation without routing live document traffic through a permanent file-scoped DO;
- the generation DO can proxy long-lived WebSockets to the Container;
- DO and Container placement latency is acceptable even when they are not colocated;
- the selected image starts within the accepted admission budget in required regions;
- PostgreSQL connectivity, fence renewal, and R2 streaming work from the Container;
- drain and `SIGTERM` preserve acknowledged work;
- a forced crash recovers from checkpoint plus operation log;
- the selected memory class stays within budget for the 50 MB fixture;
- measured active and idle costs fit the product budget.

If the placement or relocation claims fail, stop. Re-evaluate the platform rather than hiding permanent regional pinning behind reconnect UI.

## Risks and open decisions

- Cloudflare may place the generation DO and Container in different locations.
- Container image availability and capacity may override the preferred region.
- Direct PostgreSQL, Hyperdrive, and a private persistence service have different latency and credential boundaries. The spike must choose one.
- Central PostgreSQL adds latency to durable acknowledgements even when rendering is optimistic.
- Browser offline storage for private files needs an explicit retention and encryption policy.
- Signed-in read-only live sharing is specified; anonymous live sharing is not.
- Yjs adoption remains conditional on typed validation, migration, memory, and compaction evidence.
- Page-level document sharding should follow measurement, not precede it.
- Container interruption can occur without a useful shutdown window.
- Startup time and capacity refusal must remain visible, bounded states.
