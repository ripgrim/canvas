import test from "node:test";
import assert from "node:assert/strict";

import {
  AppendBeforeAckError,
  GuardedAcknowledgementSink,
  LeaseHeldError,
  MemoryGenerationRegistry,
  MemoryLeaseStore,
  MemoryMutationLog,
  MutationConflictError,
  RetiredGenerationError,
  RoomNotAcceptingError,
  RoomProcess,
  StaleFenceError,
} from "../src/index.mjs";
import { deferred, passBudget } from "../support/helpers.mjs";

function makeLeaseContext(clock = { now: 0 }) {
  const generations = new MemoryGenerationRegistry();
  generations.activate("file-a", "generation-a");
  const leases = new MemoryLeaseStore({ generations, clock: () => clock.now });
  return { clock, generations, leases };
}

function makeRoom({ leases, lease, mutationLog, checkpoint, budget = passBudget }) {
  const mutations = mutationLog ?? new MemoryMutationLog(leases);
  const acknowledgements = new GuardedAcknowledgementSink(mutations);
  return {
    acknowledgements,
    mutations,
    room: new RoomProcess({
      leaseStore: leases,
      mutationLog: mutations,
      acknowledgements,
      checkpoint,
      notifyReconnect: () => {},
      shutdownBudget: budget,
      lease,
    }),
  };
}

test("CLOUD-SYNC-LEASE-001: acquisition is exclusive and fences increase after expiry", () => {
  const { clock, leases } = makeLeaseContext();
  const first = leases.acquire("file-a", "generation-a", 100);
  assert.throws(() => leases.acquire("file-a", "generation-a", 100), LeaseHeldError);
  clock.now = 101;
  assert.equal(leases.expire("file-a"), true);
  const recovered = leases.acquire("file-a", "generation-a", 100);
  assert.ok(recovered.fence > first.fence);
  assert.throws(() => leases.assertOwner(first), StaleFenceError);
});

test("CLOUD-SYNC-LEASE-001: renewal extends TTL", () => {
  const { clock, leases } = makeLeaseContext();
  const first = leases.acquire("file-a", "generation-a", 100);
  clock.now = 50;
  const renewed = leases.renew(first, 100);
  clock.now = 120;
  assert.doesNotThrow(() => leases.assertOwner(renewed));
});

test("CLOUD-SYNC-LEASE-001: release is idempotent and permanently retires generation", () => {
  const { generations, leases } = makeLeaseContext();
  const lease = leases.acquire("file-a", "generation-a", 100);
  assert.equal(leases.release(lease), true);
  assert.equal(leases.release(lease), false);
  assert.equal(generations.isRetired("file-a", "generation-a"), true);
  assert.throws(
    () => generations.activate("file-a", "generation-a"),
    RetiredGenerationError,
  );
  assert.throws(
    () => leases.acquire("file-a", "generation-a", 100),
    RetiredGenerationError,
  );
});

test("CLOUD-SYNC-LEASE-001: stale fence cannot move checkpoint pointer", () => {
  const { clock, leases } = makeLeaseContext();
  const stale = leases.acquire("file-a", "generation-a", 100);
  clock.now = 101;
  leases.expire("file-a");
  const current = leases.acquire("file-a", "generation-a", 100);
  leases.commitCheckpoint(current, "r2://snapshot/current");
  assert.throws(
    () => leases.commitCheckpoint(stale, "r2://snapshot/stale"),
    StaleFenceError,
  );
  assert.equal(leases.readCheckpoint("file-a").pointer, "r2://snapshot/current");
});

test("negative control: stale release cannot remove current owner", () => {
  const { clock, leases } = makeLeaseContext();
  const stale = leases.acquire("file-a", "generation-a", 100);
  clock.now = 101;
  const current = leases.acquire("file-a", "generation-a", 100);
  assert.throws(() => leases.release(stale), StaleFenceError);
  assert.doesNotThrow(() => leases.assertOwner(current));
});

test("negative control: ACK-before-append is caught", async () => {
  const { leases } = makeLeaseContext();
  const mutations = new MemoryMutationLog(leases);
  const acknowledgements = new GuardedAcknowledgementSink(mutations);
  await assert.rejects(acknowledgements.acknowledge("mutation-a"), AppendBeforeAckError);
});

test("CLOUD-SYNC-LEASE-001: room appends before ACK and broadcast", async () => {
  const { leases } = makeLeaseContext();
  const lease = leases.acquire("file-a", "generation-a", 100);
  const { room } = makeRoom({
    leases,
    lease,
    checkpoint: async () => "r2://snapshot/a",
  });
  await room.mutate({ id: "mutation-a", command: "move" });
  assert.deepEqual(room.trace, [
    "append:mutation-a",
    "ack:mutation-a",
    "broadcast:mutation-a",
  ]);
});

test("CLOUD-SYNC-LEASE-001: duplicate mutation ID replays only canonical exact content", async () => {
  const { leases } = makeLeaseContext();
  const lease = leases.acquire("file-a", "generation-a", 100);
  const { acknowledgements, mutations, room } = makeRoom({
    leases,
    lease,
    checkpoint: async () => "r2://snapshot/a",
  });
  const original = {
    id: "mutation-a",
    command: "move",
    position: { x: 12, y: 24 },
  };
  const canonicalReplay = {
    position: { y: 24, x: 12 },
    command: "move",
    id: "mutation-a",
  };

  const appended = await room.mutate(original);
  const replayed = await room.mutate(canonicalReplay);

  assert.equal(appended.status, "appended");
  assert.equal(appended.broadcast, true);
  assert.equal(replayed.status, "replay");
  assert.equal(replayed.broadcast, false);
  assert.equal(replayed.digest, appended.digest);
  assert.equal(mutations.list().length, 1);
  assert.deepEqual(acknowledgements.acknowledgements, ["mutation-a", "mutation-a"]);
  assert.deepEqual(acknowledgements.receipts, [
    { duplicate: false, mutationId: "mutation-a" },
    { duplicate: true, mutationId: "mutation-a" },
  ]);
  assert.equal(
    room.trace.filter((entry) => entry === "broadcast:mutation-a").length,
    1,
  );
  assert.equal(
    room.trace.filter((entry) => entry === "ack:mutation-a:duplicate").length,
    1,
  );
});

test("negative control: duplicate mutation ID with changed content conflicts before ACK", async () => {
  const { leases } = makeLeaseContext();
  const lease = leases.acquire("file-a", "generation-a", 100);
  const { acknowledgements, mutations, room } = makeRoom({
    leases,
    lease,
    checkpoint: async () => "r2://snapshot/a",
  });
  await room.mutate({ id: "mutation-a", command: "move", x: 12 });

  await assert.rejects(
    room.mutate({ id: "mutation-a", command: "move", x: 13 }),
    MutationConflictError,
  );

  assert.equal(mutations.list().length, 1);
  assert.deepEqual(acknowledgements.acknowledgements, ["mutation-a"]);
});

test("CLOUD-SYNC-DRAIN-001: drain gates new work and awaits in-flight append", async () => {
  const { leases } = makeLeaseContext();
  const lease = leases.acquire("file-a", "generation-a", 1_000);
  const appendGate = deferred();
  const records = [];
  const mutationLog = {
    async append(activeLease, mutation) {
      leases.assertOwner(activeLease);
      await appendGate.promise;
      records.push(mutation.id);
    },
    hasExact(mutation) {
      return records.includes(mutation.id);
    },
  };
  const notices = [];
  const room = new RoomProcess({
    leaseStore: leases,
    mutationLog,
    acknowledgements: new GuardedAcknowledgementSink(mutationLog),
    checkpoint: async () => "r2://snapshot/a",
    notifyReconnect: (notice) => notices.push(notice),
    shutdownBudget: passBudget,
    lease,
  });

  const mutation = room.mutate({ id: "mutation-a", command: "move" });
  const shutdown = room.handleSignal(15);
  assert.throws(() => room.admit("connection-b"), RoomNotAcceptingError);
  assert.throws(
    () => room.mutate({ id: "mutation-b", command: "move" }),
    RoomNotAcceptingError,
  );
  assert.equal(notices[0].reason, "room_draining");
  appendGate.resolve();
  await mutation;
  assert.deepEqual(await shutdown, { status: "stopped" });
  assert.ok(room.trace.indexOf("broadcast:mutation-a") < room.trace.indexOf("checkpoint:start"));
  assert.equal(room.state, "stopped");
});

test("negative control: checkpoint failure is not reported as graceful success", async () => {
  const { leases } = makeLeaseContext();
  const lease = leases.acquire("file-a", "generation-a", 1_000);
  const failure = new Error("R2 unavailable");
  const { room } = makeRoom({
    leases,
    lease,
    checkpoint: async () => {
      throw failure;
    },
  });
  const result = await room.handleSignal(15);
  assert.equal(result.status, "checkpoint-failed");
  assert.equal(result.error, failure);
  assert.equal(room.state, "draining");
  assert.doesNotThrow(() => leases.assertOwner(lease));
  assert.ok(!room.trace.includes("process:exit:0"));
});

test("negative race: exhausted shutdown budget requires force and lease-expiry recovery", async () => {
  const { clock, leases } = makeLeaseContext();
  const lease = leases.acquire("file-a", "generation-a", 100);
  const budget = {
    async run(phase) {
      assert.equal(phase, "inflight");
      return { completed: false };
    },
  };
  const { room } = makeRoom({
    leases,
    lease,
    checkpoint: async () => "r2://snapshot/a",
    budget,
  });
  assert.deepEqual(await room.handleSignal(15), {
    status: "forced-termination-required",
  });
  room.forceTerminate();
  assert.equal(room.state, "crashed");
  assert.ok(!room.trace.includes("lease:released"));

  clock.now = 101;
  leases.expire("file-a");
  const recovered = leases.acquire("file-a", "generation-a", 100);
  assert.ok(recovered.fence > lease.fence);
});

test("negative race: forced termination prevents a late in-flight ACK", async () => {
  const { leases } = makeLeaseContext();
  const lease = leases.acquire("file-a", "generation-a", 100);
  const appendGate = deferred();
  let appended = false;
  const mutationLog = {
    async append() {
      await appendGate.promise;
      appended = true;
    },
    hasExact() {
      return appended;
    },
  };
  const acknowledgements = new GuardedAcknowledgementSink(mutationLog);
  const room = new RoomProcess({
    leaseStore: leases,
    mutationLog,
    acknowledgements,
    checkpoint: async () => "r2://snapshot/a",
    notifyReconnect: () => {},
    shutdownBudget: { run: async () => ({ completed: false }) },
    lease,
  });
  const mutation = room.mutate({ id: "mutation-a", command: "move" });
  await room.handleSignal(15);
  room.forceTerminate();
  appendGate.resolve();
  await assert.rejects(mutation, /forced-terminated/);
  assert.deepEqual(acknowledgements.acknowledgements, []);
  assert.ok(!room.trace.includes("broadcast:mutation-a"));
});
