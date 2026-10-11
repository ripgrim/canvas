import test from "node:test";
import assert from "node:assert/strict";

import {
  AdmissionCancelledError,
  ActivationFailedError,
  DuplicateConnectionError,
  FakeContainerAdapter,
  MemoryGenerationRegistry,
  ProxyAdmissionError,
  ProxyHandshakeTimeoutError,
  RetiredGenerationError,
  RoomDrainingError,
  StaleFenceError,
  createVerifiedWebSocketBridgeResult,
} from "../src/index.mjs";
import { deferred, makeAdmission, makeCoordinator } from "../support/helpers.mjs";

test("CLOUD-SYNC-CONTAINER-001: admission queues until one container is ready", async () => {
  const first = makeAdmission("connection-a", "correlation-a", "client-a");
  const second = makeAdmission("connection-b", "correlation-b", "client-b");
  const container = new FakeContainerAdapter();
  const { coordinator, events } = makeCoordinator(container);

  const firstOpen = coordinator.open(first);
  const secondOpen = coordinator.open(second);
  await Promise.resolve();

  assert.equal(container.startCount, 1);
  assert.equal(coordinator.inspect().queueDepth, 2);
  assert.equal(container.admissions.length, 0);

  container.markReady();
  const [firstResult, secondResult] = await Promise.all([firstOpen, secondOpen]);
  assert.equal(firstResult.kind, "verified-websocket-upgrade");
  assert.equal(firstResult.webSocket.connectionId, "connection-a");
  assert.equal(secondResult.webSocket.connectionId, "connection-b");
  assert.deepEqual(
    container.admissions.map(({ connectionId }) => connectionId),
    [first.connectionId, second.connectionId],
  );
  assert.equal(Object.hasOwn(container.admissions[0], "roomCapability"), false);
  assert.equal(container.inactivityTimeoutMs, 60_000);
  assert.ok(
    events
      .list()
      .every((event) => event.roomId === "sync:v1:file-a:generation-a" && event.correlationId),
  );
});

test("unique connection IDs allow two connections for one client and reject a duplicate", async () => {
  const container = new FakeContainerAdapter({ initiallyReady: true });
  const { coordinator } = makeCoordinator(container);
  await coordinator.open(makeAdmission("connection-a", "correlation-a", "client-a"));
  await coordinator.open(makeAdmission("connection-b", "correlation-b", "client-a"));
  assert.throws(
    () => coordinator.open(makeAdmission("connection-b", "correlation-c", "client-a")),
    DuplicateConnectionError,
  );
  assert.deepEqual(coordinator.inspect().activeConnections, ["connection-a", "connection-b"]);
});

test("CLOUD-SYNC-DRAIN-001: reconnect during grace cancels container stop", async () => {
  const first = makeAdmission();
  const container = new FakeContainerAdapter({ initiallyReady: true });
  const { coordinator, events, scheduler } = makeCoordinator(container);

  await coordinator.open(first);
  await coordinator.close(first);
  await scheduler.advanceBy(750);
  await coordinator.open(makeAdmission("connection-b", "correlation-b"));
  await scheduler.advanceBy(500);

  assert.equal(container.stopCount, 0);
  assert.equal(scheduler.pendingCount, 0);
  assert.equal(coordinator.inspect().phase, "ready");
  assert.ok(events.list().some((event) => event.phase === "room:shutdown-cancelled"));
});

test("negative race: open during draining is rerouted and cannot survive into cold", async () => {
  const stop = deferred();
  const container = new FakeContainerAdapter({
    initiallyReady: true,
    stopGate: stop.promise,
  });
  const { coordinator, generations, scheduler } = makeCoordinator(container);
  const admission = makeAdmission();
  await coordinator.open(admission);
  await coordinator.close(admission);

  const draining = scheduler.advanceBy(1_000);
  await Promise.resolve();
  assert.equal(coordinator.inspect().phase, "draining");
  assert.throws(
    () => coordinator.open(makeAdmission("connection-b", "correlation-b")),
    RoomDrainingError,
  );
  stop.resolve();
  await draining;

  assert.deepEqual(coordinator.inspect().activeConnections, []);
  assert.equal(coordinator.inspect().phase, "cold");
  assert.equal(generations.isRetired("file-a", "generation-a"), true);
  assert.throws(() => coordinator.open(makeAdmission()), RetiredGenerationError);
});

test("negative race: failed proxy rejects the same queued admission without dropping the next", async () => {
  let coordinator;
  let attempt = 0;
  const container = {
    running: false,
    async start() {
      this.running = true;
    },
    async setInactivityTimeout() {},
    async waitUntilReady() {},
    async proxy(admission) {
      attempt += 1;
      if (attempt === 1) {
        assert.equal(coordinator.inspect().queueDepth, 2);
        throw new Error(`proxy failed for ${admission.connectionId}`);
      }
      return createVerifiedWebSocketBridgeResult(
        { status: 101, webSocket: { connectionId: admission.connectionId } },
        async () => {},
      );
    },
  };
  ({ coordinator } = makeCoordinator(container));
  const first = coordinator.open(makeAdmission("connection-a", "correlation-a"));
  const second = coordinator.open(makeAdmission("connection-b", "correlation-b"));

  await assert.rejects(first, /proxy failed for connection-a/);
  assert.equal((await second).webSocket.connectionId, "connection-b");
  assert.deepEqual(coordinator.inspect().activeConnections, ["connection-b"]);
});

test("negative race: generation retirement during startup rejects queued admission", async () => {
  const container = new FakeContainerAdapter();
  const { coordinator, generations } = makeCoordinator(container);
  const opening = coordinator.open(makeAdmission());
  generations.retire("file-a", "generation-a");
  generations.activate("file-a", "generation-b");
  container.markReady();
  await assert.rejects(opening, RetiredGenerationError);
  assert.deepEqual(coordinator.inspect().activeConnections, []);
  assert.equal(coordinator.inspect().phase, "failed");
});

test("negative race: retirement during proxy disposes established upstream", async () => {
  const entered = deferred();
  const release = deferred();
  let disposeCount = 0;
  const container = {
    running: true,
    async start() {},
    async setInactivityTimeout() {},
    async waitUntilReady() {},
    async proxy() {
      entered.resolve();
      await release.promise;
      return createVerifiedWebSocketBridgeResult(
        { status: 101, webSocket: { id: "upstream-a" } },
        async () => {
          disposeCount += 1;
        },
      );
    },
  };
  const { coordinator, generations } = makeCoordinator(container);
  const opening = coordinator.open(makeAdmission());
  await entered.promise;
  generations.retire("file-a", "generation-a");
  generations.activate("file-a", "generation-b");
  release.resolve();
  await assert.rejects(opening, RetiredGenerationError);
  assert.equal(disposeCount, 1);
  assert.deepEqual(coordinator.inspect().activeConnections, []);
});

test("negative race: fence loss during proxy disposes established upstream", async () => {
  const entered = deferred();
  const release = deferred();
  let ownsFence = true;
  let disposeCount = 0;
  const container = {
    running: true,
    async start() {},
    async setInactivityTimeout() {},
    async waitUntilReady() {},
    async proxy() {
      entered.resolve();
      await release.promise;
      return createVerifiedWebSocketBridgeResult(
        { status: 101, webSocket: { id: "upstream-a" } },
        async () => {
          disposeCount += 1;
        },
      );
    },
  };
  const ownership = {
    fence: 1,
    assertCurrent() {
      if (!ownsFence) throw new StaleFenceError();
    },
  };
  const { coordinator } = makeCoordinator(container, { ownership });
  const opening = coordinator.open(makeAdmission());
  await entered.promise;
  ownsFence = false;
  release.resolve();
  await assert.rejects(opening, StaleFenceError);
  assert.equal(disposeCount, 1);
});

test("negative race: disconnect during startup cancels exactly that queued admission", async () => {
  const container = new FakeContainerAdapter();
  const { coordinator } = makeCoordinator(container);
  const first = makeAdmission("connection-a", "correlation-a");
  const second = makeAdmission("connection-b", "correlation-b");
  const firstOpen = coordinator.open(first);
  const secondOpen = coordinator.open(second);
  await Promise.resolve();

  await coordinator.close({
    connectionId: first.connectionId,
    correlationId: "cancel-request-a",
  });
  await assert.rejects(firstOpen, AdmissionCancelledError);
  assert.equal(coordinator.inspect().queueDepth, 1);

  container.markReady();
  assert.equal((await secondOpen).webSocket.connectionId, second.connectionId);
  assert.deepEqual(container.admissions.map(({ connectionId }) => connectionId), [
    second.connectionId,
  ]);
  assert.deepEqual(coordinator.inspect().activeConnections, [second.connectionId]);
});

test("negative race: disconnect during proxy disposes upstream without ghost activation", async () => {
  const entered = deferred();
  const release = deferred();
  let disposed = 0;
  const container = {
    running: true,
    async start() {},
    async setInactivityTimeout() {},
    async waitUntilReady() {},
    async proxy(admission) {
      entered.resolve();
      await release.promise;
      return createVerifiedWebSocketBridgeResult(
        { status: 101, webSocket: { connectionId: admission.connectionId } },
        async () => {
          disposed += 1;
        },
      );
    },
  };
  const { coordinator } = makeCoordinator(container);
  const admission = makeAdmission();
  const opening = coordinator.open(admission);
  await entered.promise;
  await coordinator.close({
    connectionId: admission.connectionId,
    correlationId: "cancel-request-a",
  });
  await assert.rejects(opening, AdmissionCancelledError);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(disposed, 1);
  assert.deepEqual(coordinator.inspect().activeConnections, []);
  assert.equal(coordinator.inspect().queueDepth, 0);
});

test("negative race: cancellation aborts a never-settling proxy and admits the next connection", async () => {
  const entered = deferred();
  let attempts = 0;
  let firstSignal;
  const container = {
    running: true,
    async start() {},
    async setInactivityTimeout() {},
    async waitUntilReady() {},
    async proxy(admission, { signal }) {
      attempts += 1;
      if (attempts === 1) {
        firstSignal = signal;
        entered.resolve();
        return new Promise(() => {});
      }
      return createVerifiedWebSocketBridgeResult(
        { status: 101, webSocket: { connectionId: admission.connectionId } },
        async () => {},
      );
    },
  };
  const { coordinator } = makeCoordinator(container);
  const first = makeAdmission("connection-a", "correlation-a");
  const second = makeAdmission("connection-b", "correlation-b");
  const firstOpen = coordinator.open(first);
  const firstRejected = assert.rejects(firstOpen, AdmissionCancelledError);
  const secondOpen = coordinator.open(second);
  await entered.promise;

  await coordinator.close({
    connectionId: first.connectionId,
    correlationId: "cancel-request-a",
  });

  await firstRejected;
  assert.equal(firstSignal.aborted, true);
  assert.equal((await secondOpen).webSocket.connectionId, second.connectionId);
  assert.deepEqual(coordinator.inspect().activeConnections, [second.connectionId]);
});

test("negative probe: bounded proxy timeout removes one admission and advances the queue", async () => {
  const entered = deferred();
  let attempts = 0;
  let firstSignal;
  const container = {
    running: true,
    async start() {},
    async setInactivityTimeout() {},
    async waitUntilReady() {},
    async proxy(admission, { signal }) {
      attempts += 1;
      if (attempts === 1) {
        firstSignal = signal;
        entered.resolve();
        return new Promise(() => {});
      }
      return createVerifiedWebSocketBridgeResult(
        { status: 101, webSocket: { connectionId: admission.connectionId } },
        async () => {},
      );
    },
  };
  const { coordinator, scheduler } = makeCoordinator(container, {
    proxyHandshakeMs: 25,
  });
  const firstOpen = coordinator.open(makeAdmission("connection-a", "correlation-a"));
  const firstRejected = assert.rejects(firstOpen, ProxyHandshakeTimeoutError);
  const secondOpen = coordinator.open(makeAdmission("connection-b", "correlation-b"));
  await entered.promise;

  await scheduler.advanceBy(25);

  await firstRejected;
  assert.equal(firstSignal.aborted, true);
  assert.equal((await secondOpen).webSocket.connectionId, "connection-b");
  assert.deepEqual(coordinator.inspect().activeConnections, ["connection-b"]);
});

test("cold-start exhaustion cleans every started Container before retirement handoff", async () => {
  let starts = 0;
  let destroys = 0;
  let delays = 0;
  const container = {
    running: false,
    async start() {
      starts += 1;
      this.running = true;
    },
    async setInactivityTimeout() {},
    async waitUntilReady() {
      throw new Error("readiness failed");
    },
    async destroy() {
      destroys += 1;
      this.running = false;
    },
  };
  const generations = new MemoryGenerationRegistry();
  generations.activate("file-a", "generation-a");
  const retire = generations.retire.bind(generations);
  generations.retire = (fileId, generationId) => {
    assert.equal(container.running, false);
    retire(fileId, generationId);
  };
  const { coordinator } = makeCoordinator(container, {
    activationAttempts: 3,
    generations,
    retryDelay: async () => {
      delays += 1;
    },
  });
  await assert.rejects(coordinator.open(makeAdmission()), ActivationFailedError);
  assert.equal(starts, 3);
  assert.equal(destroys, 3);
  assert.equal(delays, 2);
  assert.equal(container.running, false);
  assert.equal(generations.resolveCurrent("file-a"), null);
  assert.equal(generations.isRetired("file-a", "generation-a"), true);
  assert.doesNotThrow(() => generations.activate("file-a", "generation-b"));
});

test("final activation error surfaces cleanup failure after retiring generation", async () => {
  const cleanupFailure = new Error("destroy failed");
  const container = {
    running: false,
    async start() {
      this.running = true;
    },
    async setInactivityTimeout() {},
    async waitUntilReady() {
      throw new Error("readiness failed");
    },
    async destroy() {
      this.running = false;
      throw cleanupFailure;
    },
  };
  const { coordinator, generations, events } = makeCoordinator(container, {
    activationAttempts: 1,
  });
  await assert.rejects(coordinator.open(makeAdmission()), (error) => {
    assert.equal(error instanceof ActivationFailedError, true);
    assert.deepEqual(error.cleanupFailures, [cleanupFailure]);
    return true;
  });
  assert.equal(container.running, false);
  assert.equal(generations.resolveCurrent("file-a"), null);
  assert.ok(events.list().some((event) => event.phase === "container:retry-cleanup-failed"));
});

test("negative control: non-2xx raw Response rejects admission", async () => {
  const container = {
    running: true,
    async start() {},
    async setInactivityTimeout() {},
    async waitUntilReady() {},
    async proxy() {
      return new Response("busy", { status: 503 });
    },
  };
  const { coordinator } = makeCoordinator(container);
  await assert.rejects(coordinator.open(makeAdmission()), ProxyAdmissionError);
  assert.deepEqual(coordinator.inspect().activeConnections, []);
});
