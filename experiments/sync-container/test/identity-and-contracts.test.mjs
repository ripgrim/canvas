import test from "node:test";
import assert from "node:assert/strict";

import {
  EventRecorder,
  FakeContainerAdapter,
  InvalidRoomCapabilityError,
  RetiredGenerationError,
  StaleAccessEpochError,
  ViewerAdmissionDeniedError,
  createRoomIdentity,
  parseRoomIdentity,
} from "../src/index.mjs";
import { makeAdmission, makeCoordinator } from "../support/helpers.mjs";

test("CLOUD-SYNC-CONTAINER-001: generation-scoped room identity round trips", () => {
  const admission = makeAdmission();
  const roomId = createRoomIdentity(admission);
  assert.equal(roomId, "sync:v1:file-a:generation-a");
  assert.deepEqual(parseRoomIdentity(roomId), {
    protocolEpoch: "v1",
    fileId: "file-a",
    generationId: "generation-a",
  });
});

test("negative control: stable file-only room identity is rejected", () => {
  assert.throws(
    () => parseRoomIdentity("sync:v1:file-a"),
    /must include protocol epoch, file, and generation/,
  );
  assert.throws(
    () => createRoomIdentity({ protocolEpoch: "v1", fileId: "file-a" }),
    /generationId/,
  );
});

test("negative control: identifiers are bounded and syntax constrained", () => {
  const { coordinator } = makeCoordinator(
    new FakeContainerAdapter({ initiallyReady: true }),
  );
  assert.throws(
    () => coordinator.open({ ...makeAdmission(), connectionId: "x".repeat(129) }),
    /non-empty string/,
  );
  assert.throws(
    () => coordinator.open({ ...makeAdmission(), connectionId: "bad connection" }),
    /valid bounded identifier/,
  );
  assert.throws(
    () => coordinator.open({ ...makeAdmission(), roomCapability: "short" }),
    /bounded opaque/,
  );
  assert.throws(
    () => coordinator.open({ ...makeAdmission(), authorityContext: { fence: 0, leaseOwnerId: "x" } }),
    /positive safe integer/,
  );
  assert.throws(
    () => coordinator.open({ ...makeAdmission(), role: "editor" }),
    /owner or viewer/,
  );
});

test("negative control: coordinator refuses document bytes and retains metadata only", () => {
  const { coordinator } = makeCoordinator(
    new FakeContainerAdapter({ initiallyReady: true }),
  );
  assert.throws(
    () => coordinator.open({ ...makeAdmission(), documentBytes: new Uint8Array([1, 2, 3]) }),
    /cannot retain document data/,
  );
  assert.deepEqual(coordinator.inspect(), {
    activeConnections: [],
    phase: "cold",
    queueDepth: 0,
    roomId: "sync:v1:file-a:generation-a",
  });
});

test("negative control: retired generation cannot reopen", () => {
  const { coordinator, generations } = makeCoordinator(
    new FakeContainerAdapter({ initiallyReady: true }),
  );
  generations.retire("file-a", "generation-a");
  assert.throws(() => coordinator.open(makeAdmission()), RetiredGenerationError);
});

test("API-shaped authority simulation rejects viewers, stale epochs, and invalid capabilities", async () => {
  const viewer = makeCoordinator(new FakeContainerAdapter({ initiallyReady: true }));
  await assert.rejects(
    viewer.coordinator.open({ ...makeAdmission(), role: "viewer" }),
    ViewerAdmissionDeniedError,
  );

  const stale = makeCoordinator(new FakeContainerAdapter({ initiallyReady: true }));
  await assert.rejects(
    stale.coordinator.open({ ...makeAdmission(), accessEpoch: "access-0" }),
    StaleAccessEpochError,
  );

  const invalid = makeCoordinator(new FakeContainerAdapter({ initiallyReady: true }));
  await assert.rejects(
    invalid.coordinator.open({
      ...makeAdmission(),
      roomCapability: "room_capability_bad",
    }),
    InvalidRoomCapabilityError,
  );
});

test("telemetry contract requires sync context and rejects sensitive fields", () => {
  const valid = {
    phase: "admission:accepted",
    appPlatform: "web",
    appVersion: "0.0.0-spike",
    protocolEpoch: "v1",
    generation: "generation-a",
    correlationId: "correlation-a",
    authority: true,
    fence: 1,
  };
  const recorder = new EventRecorder();
  recorder.emit(valid);
  assert.equal(recorder.list().length, 1);

  assert.throws(
    () => recorder.emit({ ...valid, protocolEpoch: undefined }),
    /protocolEpoch must be a non-empty bounded string/,
  );
  assert.throws(
    () => recorder.emit({ ...valid, correlationId: undefined, requestId: undefined }),
    /correlationId or requestId/,
  );
  assert.throws(
    () => recorder.emit({ ...valid, fence: undefined }),
    /require a fence/,
  );
  assert.throws(
    () => recorder.emit({ ...valid, phase: "admission:rejected" }),
    /require errorCode/,
  );

  for (const sensitiveField of [
    "document",
    "payload",
    "cookie",
    "ticket",
    "credentials",
    "roomCapability",
    "token",
    "operation",
    "operationPayload",
    "sourcePatch",
    "apiKey",
    "authorization",
    "password",
    "secretValue",
  ]) {
    assert.throws(
      () => recorder.emit({ ...valid, detail: { [sensitiveField]: "secret" } }),
      /cannot contain sensitive field/,
    );
  }

  const mutable = { ...valid, ignored: { label: "safe" } };
  recorder.emit(mutable);
  mutable.phase = "mutated:phase";
  mutable.ignored.roomCapability = "injected_after_emit";
  const stored = recorder.list().at(-1);
  assert.equal(stored.phase, "admission:accepted");
  assert.equal(Object.hasOwn(stored, "ignored"), false);
  assert.equal(Object.isFrozen(stored), true);
});

test("telemetry context rejects coerced, empty, oversized, and malformed values", () => {
  const recorder = new EventRecorder();
  const valid = {
    phase: "admission:accepted",
    appPlatform: "web",
    appVersion: "0.0.0-spike",
    protocolEpoch: "v1",
    generation: "generation-a",
    correlationId: "correlation-a",
    authority: true,
    fence: 1,
  };
  const cases = [
    ["appPlatform", (value) => ({ ...valid, appPlatform: value })],
    ["appVersion", (value) => ({ ...valid, appVersion: value })],
    ["phase", (value) => ({ ...valid, phase: value })],
    ["protocolEpoch", (value) => ({ ...valid, protocolEpoch: value })],
    ["generation", (value) => ({ ...valid, generation: value })],
    ["correlationId", (value) => ({ ...valid, correlationId: value })],
    [
      "requestId",
      (value) => ({ ...valid, correlationId: undefined, requestId: value }),
    ],
    [
      "errorCode",
      (value) => ({
        ...valid,
        phase: "admission:rejected",
        errorCode: value,
      }),
    ],
  ];
  for (const invalid of [42, true, "", "x".repeat(300)]) {
    for (const [field, build] of cases) {
      assert.throws(
        () => recorder.emit(build(invalid)),
        new RegExp(`${field} must be a non-empty bounded string`),
      );
    }
  }

  for (const invalidEvent of [
    { ...valid, appPlatform: "chrome" },
    { ...valid, appVersion: "version-one" },
    { ...valid, phase: "Admission accepted" },
    { ...valid, protocolEpoch: "v01" },
    { ...valid, generation: "bad generation" },
    { ...valid, correlationId: "bad reference" },
    { ...valid, phase: "admission:rejected", errorCode: "bad code" },
  ]) {
    assert.throws(() => recorder.emit(invalidEvent), /valid syntax/);
  }

  for (const fence of ["1", true, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => recorder.emit({ ...valid, fence }),
      /positive safe integer/,
    );
  }
});

test("coordinator telemetry never records the room capability", async () => {
  const { coordinator, events } = makeCoordinator(
    new FakeContainerAdapter({ initiallyReady: true }),
  );
  await coordinator.open(makeAdmission());
  const serialized = JSON.stringify(events.list());
  assert.doesNotMatch(serialized, /room_capability_a1/);
  assert.match(serialized, /"appPlatform":"web"/);
  assert.match(serialized, /"appVersion":"0.0.0-spike"/);
  assert.match(serialized, /"protocolEpoch":"v1"/);
  assert.match(serialized, /"generation":"generation-a"/);
  assert.match(serialized, /"fence":1/);
});
