import test from "node:test";
import assert from "node:assert/strict";

import {
  CloudflareContainerAdapter,
  WebSocketBridgeUnavailableError,
  createVerifiedWebSocketBridgeResult,
} from "../src/index.mjs";
import { deferred, makeAdmission } from "../support/helpers.mjs";

function makeContext({ running = false } = {}) {
  const calls = [];
  let isRunning = running;
  let monitor = deferred();
  const fetcher = { name: "container-port" };
  const container = {
    get running() {
      return isRunning;
    },
    start(options) {
      calls.push(["start", options]);
      isRunning = true;
    },
    async setInactivityTimeout(durationMs) {
      calls.push(["setInactivityTimeout", durationMs]);
    },
    getTcpPort(port) {
      calls.push(["getTcpPort", port]);
      return fetcher;
    },
    monitor() {
      calls.push(["monitor"]);
      return monitor.promise;
    },
    signal(signal) {
      calls.push(["signal", signal]);
      isRunning = false;
      monitor.resolve();
    },
    async destroy(reason) {
      calls.push(["destroy", reason]);
      isRunning = false;
      monitor.resolve();
    },
  };
  return {
    calls,
    container,
    context: { container },
    fetcher,
    replaceMonitor() {
      monitor = deferred();
    },
    completeExit() {
      isRunning = false;
      monitor.resolve();
    },
  };
}

function makeUpgradeResponse(webSocket) {
  const response = new Response(null, { status: 200 });
  return new Proxy(response, {
    get(target, property) {
      if (property === "status") return 101;
      if (property === "ok") return false;
      if (property === "webSocket") return webSocket;
      return Reflect.get(target, property, target);
    },
  });
}

test("CLOUD-SYNC-CONTAINER-001: adapter starts, monitors, bridges WebSocket, and SIGTERMs", async () => {
  const target = makeContext();
  const bridgeCalls = [];
  let disposeCount = 0;
  const adapter = new CloudflareContainerAdapter({
    context: target.context,
    port: 8080,
    ready: async () => target.calls.push(["ready"]),
    startOptions: {
      image: "images.room",
      entrypoint: ["node", "server.mjs"],
      enableInternet: false,
    },
    webSocketBridge: {
      async connect(input) {
        bridgeCalls.push(input);
        const response = makeUpgradeResponse({ id: "upstream-a" });
        assert.equal(response instanceof Response, true);
        assert.equal(response.status, 101);
        assert.equal(response.ok, false);
        return createVerifiedWebSocketBridgeResult(response, async () => {
          disposeCount += 1;
        });
      },
    },
    keepAliveMs: 20_000,
  });

  await adapter.start();
  await adapter.setInactivityTimeout(30_000);
  await adapter.waitUntilReady();
  const proxyAbort = new AbortController();
  const response = await adapter.proxy(makeAdmission(), { signal: proxyAbort.signal });
  await adapter.stopGracefully();

  assert.equal(response.kind, "verified-websocket-upgrade");
  assert.equal(response.status, 101);
  assert.equal(response.cancel, response.dispose);
  await response.dispose("test");
  await response.dispose("duplicate");
  assert.equal(disposeCount, 1);
  assert.equal(bridgeCalls[0].fetcher, target.fetcher);
  assert.equal(bridgeCalls[0].keepAliveMs, 20_000);
  assert.equal(bridgeCalls[0].signal, proxyAbort.signal);
  assert.deepEqual(target.calls.map((call) => call[0]), [
    "start",
    "monitor",
    "setInactivityTimeout",
    "getTcpPort",
    "ready",
    "getTcpPort",
    "signal",
  ]);
  assert.deepEqual(target.calls.at(-1), ["signal", 15]);
});

test("negative control: absent WebSocket bridge fails instead of pretending HTTP is enough", async () => {
  const target = makeContext({ running: true });
  const adapter = new CloudflareContainerAdapter({
    context: target.context,
    port: 8080,
    ready: async () => {},
  });
  await assert.rejects(
    adapter.proxy(makeAdmission(), { signal: new AbortController().signal }),
    WebSocketBridgeUnavailableError,
  );
});

test("DO restart restores inactivity timeout and monitoring for running Container", async () => {
  const target = makeContext({ running: true });
  const exits = [];
  const adapter = new CloudflareContainerAdapter({
    context: target.context,
    port: 8080,
    ready: async () => {},
    webSocketBridge: {
      connect: async () =>
        createVerifiedWebSocketBridgeResult(
          makeUpgradeResponse({ id: "upstream-a" }),
          async () => {},
        ),
    },
    lifecycle: { onExit: () => exits.push("exit") },
  });

  assert.equal(await adapter.restoreAfterDurableObjectRestart(45_000), true);
  assert.deepEqual(target.calls.map((call) => call[0]), [
    "setInactivityTimeout",
    "monitor",
  ]);
  await adapter.stopGracefully();
  assert.deepEqual(exits, ["exit"]);
});

test("stopGracefully does not signal a Container that already exited", async () => {
  const target = makeContext({ running: false });
  const adapter = new CloudflareContainerAdapter({
    context: target.context,
    port: 8080,
    ready: async () => {},
  });
  assert.deepEqual(await adapter.stopGracefully(), { status: "already-stopped" });
  assert.ok(!target.calls.some((call) => call[0] === "signal"));
});

test("stopGracefully tolerates monitor settlement before signal", async () => {
  const target = makeContext({ running: true });
  const adapter = new CloudflareContainerAdapter({
    context: target.context,
    port: 8080,
    ready: async () => {},
  });
  await adapter.start();
  target.completeExit();
  assert.deepEqual(await adapter.stopGracefully(), { status: "already-stopped" });
  assert.ok(!target.calls.some((call) => call[0] === "signal"));
});
