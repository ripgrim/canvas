import { assertCoordinatorAdmission, assertMetadataOnly } from "./contracts.mjs";
import { assertVerifiedWebSocketBridgeResult } from "./cloudflare-container-adapter.mjs";
import { createRoomIdentity, parseRoomIdentity } from "./identity.mjs";

export class RoomDrainingError extends Error {
  constructor() {
    super("Room is draining. Resolve the file's current generation and reconnect.");
    this.name = "RoomDrainingError";
    this.retryWithCurrentGeneration = true;
  }
}

export class DuplicateConnectionError extends Error {
  constructor() {
    super("Connection ID is already admitted or queued.");
    this.name = "DuplicateConnectionError";
  }
}

export class AdmissionCancelledError extends Error {
  constructor() {
    super("Admission was cancelled before the connection became active.");
    this.name = "AdmissionCancelledError";
  }
}

export class ProxyAdmissionError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "ProxyAdmissionError";
    this.status = status;
  }
}

export class ProxyHandshakeTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Container proxy handshake exceeded ${timeoutMs} ms.`);
    this.name = "ProxyHandshakeTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ActivationFailedError extends Error {
  constructor(cause, cleanupFailures = []) {
    const cleanupNote = cleanupFailures.length > 0 ? " Container cleanup also failed." : "";
    super(`Container activation failed and this room generation was retired.${cleanupNote}`, {
      cause,
    });
    this.name = "ActivationFailedError";
    this.cleanupFailures = [...cleanupFailures];
  }
}

export class RoomCoordinator {
  #roomId;
  #identity;
  #container;
  #generations;
  #ownership;
  #events;
  #scheduler;
  #graceMs;
  #inactivityMs;
  #activationAttempts;
  #retryDelay;
  #proxyHandshakeMs;
  #telemetryContext;
  #queue = [];
  #pendingConnections = new Set();
  #connections = new Map();
  #activation = null;
  #shutdownTask = null;
  #phase = "cold";

  constructor({
    roomId,
    container,
    generations,
    ownership,
    events,
    scheduler,
    graceMs,
    inactivityMs,
    activationAttempts,
    retryDelay,
    proxyHandshakeMs,
    telemetryContext,
  }) {
    this.#identity = parseRoomIdentity(roomId);
    generations.assertCurrent(this.#identity.fileId, this.#identity.generationId);
    this.#roomId = roomId;
    this.#container = container;
    this.#generations = generations;
    if (!ownership || typeof ownership.assertCurrent !== "function") {
      throw new TypeError("A current lease/fence ownership guard is required.");
    }
    if (!Number.isSafeInteger(ownership.fence) || ownership.fence <= 0) {
      throw new TypeError("Ownership guard requires a positive current fence.");
    }
    this.#ownership = ownership;
    this.#events = events;
    this.#scheduler = scheduler;
    this.#graceMs = graceMs;
    this.#inactivityMs = inactivityMs;
    if (!Number.isInteger(activationAttempts) || activationAttempts < 1 || activationAttempts > 10) {
      throw new RangeError("Activation attempts must be an integer from 1 through 10.");
    }
    if (typeof retryDelay !== "function") {
      throw new TypeError("An activation retry delay function is required.");
    }
    if (!Number.isFinite(proxyHandshakeMs) || proxyHandshakeMs <= 0) {
      throw new RangeError("Proxy handshake timeout must be positive.");
    }
    if (
      !telemetryContext ||
      typeof telemetryContext.appPlatform !== "string" ||
      typeof telemetryContext.appVersion !== "string"
    ) {
      throw new TypeError("Telemetry context requires appPlatform and appVersion.");
    }
    this.#activationAttempts = activationAttempts;
    this.#retryDelay = retryDelay;
    this.#proxyHandshakeMs = proxyHandshakeMs;
    this.#telemetryContext = Object.freeze({ ...telemetryContext });
  }

  open(rawAdmission) {
    const admission = assertCoordinatorAdmission(rawAdmission);
    if (this.#phase === "draining") {
      throw new RoomDrainingError();
    }
    if (this.#phase === "failed") {
      throw new RoomDrainingError();
    }
    this.#assertAuthority();
    const expectedRoomId = createRoomIdentity(admission);
    if (expectedRoomId !== this.#roomId) {
      throw new TypeError("Admission generation does not match this coordinator.");
    }
    if (
      this.#pendingConnections.has(admission.connectionId) ||
      this.#connections.has(admission.connectionId)
    ) {
      throw new DuplicateConnectionError();
    }
    this.#cancelShutdown(admission.correlationId);
    this.#pendingConnections.add(admission.connectionId);
    return new Promise((resolve, reject) => {
      const queued = { admission, resolve, reject, proxying: false, settled: false };
      queued.cancellation = new Promise((resolveCancellation) => {
        queued.cancelProxy = (error) => {
          if (!queued.cancellationReason) {
            queued.cancellationReason = error;
            resolveCancellation(error);
          }
          queued.abortController?.abort(error);
        };
      });
      this.#queue.push(queued);
      this.#emit("admission:queued", admission.correlationId, {
        queueDepth: this.#queue.length,
      });
      this.#ensureActivation();
    });
  }

  async close({ connectionId, correlationId }) {
    if (typeof connectionId !== "string" || connectionId.length === 0 || connectionId.length > 128) {
      throw new TypeError("A bounded connection ID is required.");
    }
    const queuedIndex = this.#queue.findIndex(
      (queued) => queued.admission.connectionId === connectionId,
    );
    if (queuedIndex !== -1) {
      const queued = this.#queue[queuedIndex];
      queued.cancelled = true;
      const cancellation = new AdmissionCancelledError();
      queued.cancelProxy(cancellation);
      this.#pendingConnections.delete(connectionId);
      if (!queued.proxying) {
        this.#queue.splice(queuedIndex, 1);
      }
      this.#rejectAdmission(queued, cancellation);
      this.#emit("admission:cancelled", correlationId ?? queued.admission.correlationId, {
        connectionId,
      });
      return;
    }
    const connection = this.#connections.get(connectionId);
    this.#connections.delete(connectionId);
    if (connection) {
      await connection.upstream.dispose("client_closed");
    }
    this.#emit("connection:closed", correlationId, {
      activeConnections: this.#connections.size,
    });
    this.#scheduleShutdownIfEmpty(correlationId);
  }

  inspect() {
    const metadata = {
      activeConnections: [...this.#connections.keys()],
      phase: this.#phase,
      queueDepth: this.#queue.length,
      roomId: this.#roomId,
    };
    assertMetadataOnly(metadata);
    return metadata;
  }

  #ensureActivation() {
    if (this.#activation) {
      return;
    }
    this.#activation = this.#activate()
      .catch(() => undefined)
      .finally(() => {
        this.#activation = null;
        if (this.#queue.length > 0 && this.#phase !== "failed") {
          this.#ensureActivation();
        }
      });
  }

  async #activate() {
    const correlationId = this.#queue[0].admission.correlationId;
    try {
      this.#assertAuthority();
      await this.#ensureContainerReady(correlationId);
      this.#phase = "ready";
      this.#emit("container:ready", correlationId);
      while (this.#queue.length > 0) {
        const queued = this.#queue[0];
        this.#assertAuthority();
        queued.proxying = true;
        let result;
        try {
          result = await this.#proxyAdmission(queued);
          if (result instanceof Response && !result.ok) {
            throw new ProxyAdmissionError(
              `Container rejected admission with HTTP ${result.status}.`,
              result.status,
            );
          }
          result = assertVerifiedWebSocketBridgeResult(result);
        } catch (error) {
          this.#removeQueued(queued);
          this.#pendingConnections.delete(queued.admission.connectionId);
          if (!queued.cancelled) {
            this.#emit("admission:rejected", queued.admission.correlationId, {
              errorCode: error?.name ?? "ProxyAdmissionError",
            });
            this.#rejectAdmission(queued, error);
          }
          continue;
        }
        if (queued.cancelled) {
          await result.dispose("admission_cancelled_during_proxy");
          this.#removeQueued(queued);
          this.#emit("admission:cancelled-upstream", queued.admission.correlationId, {
            connectionId: queued.admission.connectionId,
          });
          continue;
        }
        try {
          this.#assertAuthority();
        } catch (error) {
          await result.dispose("authority_changed_after_upgrade");
          throw error;
        }
        this.#removeQueued(queued);
        this.#pendingConnections.delete(queued.admission.connectionId);
        this.#connections.set(queued.admission.connectionId, {
          clientId: queued.admission.clientId,
          upstream: result,
        });
        this.#emit("admission:accepted", queued.admission.correlationId, {
          activeConnections: this.#connections.size,
        });
        queued.settled = true;
        queued.resolve(result);
      }
      this.#scheduleShutdownIfEmpty(correlationId);
    } catch (error) {
      this.#phase = "failed";
      while (this.#queue.length > 0) {
        const queued = this.#queue.shift();
        this.#pendingConnections.delete(queued.admission.connectionId);
        this.#rejectAdmission(queued, error);
      }
      throw error;
    }
  }

  async #ensureContainerReady(correlationId) {
    let lastError;
    const cleanupFailures = [];
    for (let attempt = 1; attempt <= this.#activationAttempts; attempt += 1) {
      try {
        if (!this.#container.running) {
          this.#phase = "starting";
          this.#emit("container:starting", correlationId, { attempt });
          await this.#container.start();
          await this.#container.setInactivityTimeout(this.#inactivityMs);
        }
        this.#phase = "waiting-ready";
        this.#emit("container:waiting-ready", correlationId, { attempt });
        await this.#container.waitUntilReady();
        return;
      } catch (error) {
        lastError = error;
        this.#emit("container:activation-failed", correlationId, {
          attempt,
          errorCode: error?.name ?? "ContainerActivationError",
        });
        if (this.#container.running) {
          if (typeof this.#container.destroy === "function") {
            try {
              await this.#container.destroy("activation_retry");
            } catch (destroyError) {
              cleanupFailures.push(destroyError);
              this.#emit("container:retry-cleanup-failed", correlationId, {
                attempt,
                errorCode: destroyError?.name ?? "ContainerCleanupError",
                errorName: destroyError?.name ?? "Error",
              });
            }
          } else {
            const destroyError = new Error("Container adapter has no destroy method.");
            cleanupFailures.push(destroyError);
            this.#emit("container:retry-cleanup-failed", correlationId, {
              attempt,
              errorCode: destroyError.name,
              errorName: destroyError.name,
            });
          }
        }
        if (attempt === this.#activationAttempts) {
          this.#retireFailedGeneration(correlationId);
          throw new ActivationFailedError(lastError, cleanupFailures);
        }
        try {
          await this.#retryDelay(attempt);
        } catch (delayError) {
          this.#retireFailedGeneration(correlationId);
          throw new ActivationFailedError(delayError, cleanupFailures);
        }
      }
    }
  }

  #cancelShutdown(correlationId) {
    if (this.#shutdownTask) {
      this.#scheduler.cancel(this.#shutdownTask);
      this.#shutdownTask = null;
      this.#phase = "ready";
      this.#emit("room:shutdown-cancelled", correlationId);
    }
  }

  async #proxyAdmission(queued) {
    const abortController = new AbortController();
    queued.abortController = abortController;
    if (queued.cancellationReason) {
      abortController.abort(queued.cancellationReason);
    }
    const timeoutError = new ProxyHandshakeTimeoutError(this.#proxyHandshakeMs);
    const timeoutTask = this.#scheduler.schedule(this.#proxyHandshakeMs, () => {
      queued.cancelProxy(timeoutError);
    });
    const proxy = Promise.resolve()
      .then(() =>
        this.#container.proxy(queued.admission, {
          signal: abortController.signal,
        }),
      )
      .then(async (result) => {
        if (abortController.signal.aborted) {
          try {
            const verified = assertVerifiedWebSocketBridgeResult(result);
            await verified.cancel("proxy_resolved_after_abort");
          } catch {
            // An aborted non-upgrade has no upstream handle to close.
          }
          throw abortController.signal.reason;
        }
        return result;
      });
    try {
      return await Promise.race([
        proxy,
        queued.cancellation.then((error) => Promise.reject(error)),
      ]);
    } finally {
      this.#scheduler.cancel(timeoutTask);
      queued.abortController = null;
    }
  }

  #scheduleShutdownIfEmpty(correlationId) {
    if (
      this.#connections.size !== 0 ||
      this.#queue.length !== 0 ||
      this.#phase !== "ready" ||
      this.#shutdownTask
    ) {
      return;
    }
    this.#phase = "idle";
    this.#emit("room:idle", correlationId, { graceMs: this.#graceMs });
    this.#shutdownTask = this.#scheduler.schedule(this.#graceMs, async () => {
      this.#shutdownTask = null;
      await this.#drain(correlationId);
    });
  }

  #removeQueued(queued) {
    const index = this.#queue.indexOf(queued);
    if (index !== -1) {
      this.#queue.splice(index, 1);
    }
  }

  #rejectAdmission(queued, error) {
    if (queued.settled) {
      return;
    }
    queued.settled = true;
    queued.reject(error);
  }

  async #drain(correlationId) {
    if (this.#connections.size !== 0) {
      throw new Error("Refusing to drain a room with active connections.");
    }
    this.#phase = "draining";
    this.#emit("container:draining", correlationId);
    try {
      await this.#container.stopGracefully();
      if (this.#connections.size !== 0) {
        throw new Error("Room gained an active connection while draining.");
      }
      this.#generations.retire(this.#identity.fileId, this.#identity.generationId);
      this.#phase = "cold";
      this.#emit("container:stopped", correlationId);
    } catch (error) {
      this.#phase = "failed";
      this.#emit("container:drain-failed", correlationId, {
        errorCode: error?.name ?? "ContainerDrainError",
      });
      throw error;
    }
  }

  #emit(phase, correlationId, detail = {}) {
    this.#events.emit({
      phase,
      correlationId,
      roomId: this.#roomId,
      protocolEpoch: this.#identity.protocolEpoch,
      generation: this.#identity.generationId,
      authority: true,
      fence: this.#ownership.fence,
      appPlatform: this.#telemetryContext.appPlatform,
      appVersion: this.#telemetryContext.appVersion,
      ...detail,
    });
  }

  #assertAuthority() {
    this.#generations.assertCurrent(this.#identity.fileId, this.#identity.generationId);
    this.#ownership.assertCurrent();
  }

  #retireFailedGeneration(correlationId) {
    this.#generations.retire(this.#identity.fileId, this.#identity.generationId);
    this.#emit("generation:retired", correlationId, { reason: "activation_failed" });
  }
}
