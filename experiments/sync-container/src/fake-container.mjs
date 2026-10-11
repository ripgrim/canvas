import { createVerifiedWebSocketBridgeResult } from "./cloudflare-container-adapter.mjs";

export class ViewerAdmissionDeniedError extends Error {
  constructor() {
    super("Viewer role cannot enter the editable sync room.");
    this.name = "ViewerAdmissionDeniedError";
  }
}

export class StaleAccessEpochError extends Error {
  constructor() {
    super("Admission access epoch is stale.");
    this.name = "StaleAccessEpochError";
  }
}

export class InvalidRoomCapabilityError extends Error {
  constructor() {
    super("Room capability is invalid.");
    this.name = "InvalidRoomCapabilityError";
  }
}

export class FakeContainerAdapter {
  #readyPromise;
  #resolveReady;
  #roomProcess;
  #stopGate;
  #running = false;
  #ready = false;
  #currentAccessEpoch;
  #expectedCapability;
  #currentFence;
  startCount = 0;
  stopCount = 0;
  inactivityTimeoutMs = null;
  admissions = [];

  constructor({
    roomProcess,
    initiallyReady = false,
    stopGate = null,
    currentAccessEpoch = "access-1",
    expectedCapability = "room_capability_a1",
    currentFence = 1,
  } = {}) {
    this.#roomProcess = roomProcess;
    this.#stopGate = stopGate;
    this.#currentAccessEpoch = currentAccessEpoch;
    this.#expectedCapability = expectedCapability;
    this.#currentFence = currentFence;
    this.#readyPromise = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
    if (initiallyReady) {
      this.markReady();
    }
  }

  get running() {
    return this.#running;
  }

  async start() {
    if (this.#running) {
      throw new Error("Container is already running.");
    }
    this.#running = true;
    this.startCount += 1;
  }

  async setInactivityTimeout(durationMs) {
    this.inactivityTimeoutMs = durationMs;
  }

  markReady() {
    this.#ready = true;
    this.#resolveReady();
  }

  async waitUntilReady() {
    await this.#readyPromise;
  }

  async proxy(admission, { signal } = {}) {
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError("Fake Container proxy requires an AbortSignal.");
    }
    signal.throwIfAborted();
    if (!this.#running || !this.#ready) {
      throw new Error("Container is not ready.");
    }
    if (admission.role === "viewer") {
      throw new ViewerAdmissionDeniedError();
    }
    if (
      admission.accessEpoch !== this.#currentAccessEpoch ||
      admission.authorityContext.fence !== this.#currentFence
    ) {
      throw new StaleAccessEpochError();
    }
    if (admission.roomCapability !== this.#expectedCapability) {
      throw new InvalidRoomCapabilityError();
    }
    signal.throwIfAborted();
    this.admissions.push(
      Object.freeze({
        accessEpoch: admission.accessEpoch,
        connectionId: admission.connectionId,
        role: admission.role,
        subjectId: admission.subjectId,
      }),
    );
    return createVerifiedWebSocketBridgeResult(
      {
        status: 101,
        webSocket: { connectionId: admission.connectionId },
      },
      async () => {},
    );
  }

  async stopGracefully() {
    if (this.#stopGate) {
      await this.#stopGate;
    }
    if (this.#roomProcess) {
      const result = await this.#roomProcess.handleSignal(15);
      if (result.status !== "stopped") {
        throw new Error(`Room process did not stop: ${result.status}.`);
      }
    }
    this.#running = false;
    this.#ready = false;
    this.stopCount += 1;
  }

  async destroy() {
    this.#running = false;
    this.#ready = false;
  }
}
