export class AppendBeforeAckError extends Error {
  constructor() {
    super("Mutation acknowledgement attempted before durable append.");
    this.name = "AppendBeforeAckError";
  }
}

export class RoomNotAcceptingError extends Error {
  constructor() {
    super("Room is draining and no longer accepts admissions or operations.");
    this.name = "RoomNotAcceptingError";
  }
}

export class GracefulStopIncompleteError extends Error {
  constructor(status) {
    super(`Room did not complete graceful shutdown: ${status}.`);
    this.name = "GracefulStopIncompleteError";
    this.status = status;
  }
}

export class RealShutdownBudget {
  #deadline;

  constructor(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Shutdown budget must be positive.");
    }
    this.#deadline = Date.now() + timeoutMs;
  }

  async run(_phase, work) {
    const remainingMs = this.#deadline - Date.now();
    if (remainingMs <= 0) {
      return { completed: false };
    }
    let timeout;
    const outcome = await Promise.race([
      Promise.resolve(work).then(
        (value) => ({ completed: true, value }),
        (error) => ({ completed: true, error }),
      ),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ completed: false }), remainingMs);
      }),
    ]);
    clearTimeout(timeout);
    return outcome;
  }
}

export class GuardedAcknowledgementSink {
  #mutationLog;
  acknowledgements = [];
  receipts = [];

  constructor(mutationLog) {
    this.#mutationLog = mutationLog;
  }

  async acknowledge(mutation, { duplicate = false } = {}) {
    if (!this.#mutationLog.hasExact?.(mutation)) {
      throw new AppendBeforeAckError();
    }
    this.acknowledgements.push(mutation.id);
    const receipt = Object.freeze({ duplicate, mutationId: mutation.id });
    this.receipts.push(receipt);
    return receipt;
  }
}

export class RoomProcess {
  #leaseStore;
  #mutationLog;
  #acknowledgements;
  #checkpoint;
  #notifyReconnect;
  #shutdownBudget;
  #lease;
  #state = "accepting";
  #inFlight = new Set();
  #drainPromise = null;
  trace = [];

  constructor({
    leaseStore,
    mutationLog,
    acknowledgements,
    checkpoint,
    notifyReconnect,
    shutdownBudget,
    lease,
  }) {
    this.#leaseStore = leaseStore;
    this.#mutationLog = mutationLog;
    this.#acknowledgements = acknowledgements;
    this.#checkpoint = checkpoint;
    this.#notifyReconnect = notifyReconnect;
    this.#shutdownBudget = shutdownBudget;
    this.#lease = lease;
  }

  get state() {
    return this.#state;
  }

  admit(connectionId) {
    this.#assertAccepting();
    this.#leaseStore.assertOwner(this.#lease);
    this.trace.push(`admit:${connectionId}`);
  }

  mutate(mutation) {
    this.#assertAccepting();
    const task = this.#commit(mutation);
    this.#inFlight.add(task);
    void task.then(
      () => this.#inFlight.delete(task),
      () => this.#inFlight.delete(task),
    );
    return task;
  }

  handleSignal(signal) {
    if (signal !== 15) {
      throw new TypeError("Room process only accepts SIGTERM (15) for graceful shutdown.");
    }
    if (this.#state === "stopped") {
      return Promise.resolve({ status: "stopped" });
    }
    if (this.#drainPromise) {
      return this.#drainPromise;
    }
    this.#state = "draining";
    this.trace.push("gate:closed");
    try {
      this.#notifyReconnect({
        fileId: this.#lease.fileId,
        generationId: this.#lease.generationId,
        reason: "room_draining",
      });
      this.trace.push("reconnect:notified");
    } catch {
      this.trace.push("reconnect:notify-failed");
    }
    this.#drainPromise = this.#drain();
    return this.#drainPromise;
  }

  forceTerminate(reason = "shutdown_budget_exhausted") {
    if (this.#state === "stopped") {
      return;
    }
    this.#state = "crashed";
    this.trace.push(`process:forced:${reason}`);
  }

  async #commit(mutation) {
    this.#leaseStore.assertOwner(this.#lease);
    this.trace.push(`append:${mutation.id}`);
    const appendResult = await this.#mutationLog.append(this.#lease, mutation);
    if (this.#state === "crashed") {
      throw new GracefulStopIncompleteError("forced-terminated");
    }
    if (appendResult?.status === "replay") {
      this.trace.push(`ack:${mutation.id}:duplicate`);
      await this.#acknowledgements.acknowledge(mutation, { duplicate: true });
      return Object.freeze({ ...appendResult, broadcast: false });
    }
    this.trace.push(`ack:${mutation.id}`);
    await this.#acknowledgements.acknowledge(mutation);
    this.trace.push(`broadcast:${mutation.id}`);
    return Object.freeze({ ...appendResult, broadcast: true });
  }

  async #drain() {
    const inflight = await this.#shutdownBudget.run(
      "inflight",
      Promise.allSettled([...this.#inFlight]),
    );
    if (!inflight.completed) {
      this.trace.push("shutdown:budget-exhausted:inflight");
      return { status: "forced-termination-required" };
    }

    this.trace.push("checkpoint:start");
    const checkpoint = await this.#shutdownBudget.run(
      "checkpoint",
      Promise.resolve().then(() => this.#checkpoint()),
    );
    if (!checkpoint.completed || checkpoint.error) {
      this.trace.push("checkpoint:failed");
      return {
        status: "checkpoint-failed",
        error: checkpoint.error,
      };
    }

    try {
      this.#leaseStore.commitCheckpoint(this.#lease, checkpoint.value);
      this.trace.push("checkpoint:committed");
      this.#leaseStore.release(this.#lease);
      this.trace.push("lease:released");
      this.#state = "stopped";
      this.trace.push("process:exit:0");
      return { status: "stopped" };
    } catch (error) {
      this.trace.push("checkpoint:failed");
      return { status: "checkpoint-failed", error };
    }
  }

  #assertAccepting() {
    if (this.#state !== "accepting") {
      throw new RoomNotAcceptingError();
    }
  }
}
