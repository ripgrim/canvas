import {
  EventRecorder,
  ManualScheduler,
  MemoryGenerationRegistry,
  RoomCoordinator,
  createRoomIdentity,
} from "../src/index.mjs";

export function makeAdmission(
  connectionId = "connection-a",
  correlationId = "correlation-a",
  clientId = "client-a",
) {
  return {
    clientId,
    connectionId,
    correlationId,
    fileId: "file-a",
    generationId: "generation-a",
    protocolEpoch: "v1",
    roomCapability: "room_capability_a1",
    subjectId: "subject-a",
    role: "owner",
    accessEpoch: "access-1",
    authorityContext: Object.freeze({ fence: 1, leaseOwnerId: "lease-owner-a" }),
    transport: "websocket",
  };
}

export function makeGeneration() {
  const generations = new MemoryGenerationRegistry();
  generations.activate("file-a", "generation-a");
  return generations;
}

export function makeCoordinator(container, overrides = {}) {
  const admission = makeAdmission();
  const generations = overrides.generations ?? makeGeneration();
  const events = overrides.events ?? new EventRecorder();
  const scheduler = overrides.scheduler ?? new ManualScheduler();
  const coordinator = new RoomCoordinator({
    roomId: createRoomIdentity(admission),
    container,
    generations,
    ownership: overrides.ownership ?? { fence: 1, assertCurrent() {} },
    events,
    scheduler,
    graceMs: overrides.graceMs ?? 1_000,
    inactivityMs: overrides.inactivityMs ?? 60_000,
    activationAttempts: overrides.activationAttempts ?? 3,
    retryDelay: overrides.retryDelay ?? (async () => {}),
    proxyHandshakeMs: overrides.proxyHandshakeMs ?? 5_000,
    telemetryContext: overrides.telemetryContext ?? {
      appPlatform: "web",
      appVersion: "0.0.0-spike",
    },
  });
  return { admission, coordinator, events, generations, scheduler };
}

export const passBudget = {
  async run(_phase, work) {
    try {
      return { completed: true, value: await work };
    } catch (error) {
      return { completed: true, error };
    }
  },
};

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
