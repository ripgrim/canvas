const SIGTERM = 15;
const VERIFIED_UPGRADE = Symbol("verified-websocket-upgrade");

export class WebSocketBridgeUnavailableError extends Error {
  constructor() {
    super("The Cloudflare WebSocket bridge and keepalive contract is not implemented.");
    this.name = "WebSocketBridgeUnavailableError";
  }
}

export class InvalidWebSocketUpgradeError extends Error {
  constructor(message = "WebSocket bridge did not return a verified HTTP 101 upgrade.") {
    super(message);
    this.name = "InvalidWebSocketUpgradeError";
  }
}

export function createVerifiedWebSocketBridgeResult(response, disposeUpstream) {
  if (!response || response.status !== 101 || !response.webSocket) {
    throw new InvalidWebSocketUpgradeError();
  }
  if (typeof disposeUpstream !== "function") {
    throw new InvalidWebSocketUpgradeError("WebSocket bridge requires an upstream disposer.");
  }
  let disposal = null;
  const dispose = (reason) => {
    if (!disposal) {
      disposal = Promise.resolve().then(() => disposeUpstream(reason));
    }
    return disposal;
  };
  return Object.freeze({
    [VERIFIED_UPGRADE]: true,
    kind: "verified-websocket-upgrade",
    status: 101,
    webSocket: response.webSocket,
    cancel: dispose,
    dispose,
  });
}

export function assertVerifiedWebSocketBridgeResult(result) {
  if (
    !result ||
    result[VERIFIED_UPGRADE] !== true ||
    result.kind !== "verified-websocket-upgrade" ||
    result.status !== 101 ||
    !result.webSocket ||
    typeof result.cancel !== "function" ||
    typeof result.dispose !== "function"
  ) {
    throw new InvalidWebSocketUpgradeError();
  }
  return result;
}

export class CloudflareContainerAdapter {
  #container;
  #port;
  #ready;
  #startOptions;
  #webSocketBridge;
  #keepAliveMs;
  #lifecycle;
  #monitoring = null;

  constructor({
    context,
    port,
    ready,
    startOptions,
    webSocketBridge = null,
    keepAliveMs = 20_000,
    lifecycle = {},
  }) {
    if (!context?.container) {
      throw new TypeError("A Durable Object context with ctx.container is required.");
    }
    if (!Number.isFinite(keepAliveMs) || keepAliveMs <= 0) {
      throw new RangeError("WebSocket keepalive interval must be positive.");
    }
    this.#container = context.container;
    this.#port = port;
    this.#ready = ready;
    this.#startOptions = startOptions;
    this.#webSocketBridge = webSocketBridge;
    this.#keepAliveMs = keepAliveMs;
    this.#lifecycle = lifecycle;
  }

  get running() {
    return this.#container.running;
  }

  async start() {
    if (!this.#container.running) {
      if (this.#startOptions === undefined) {
        this.#container.start();
      } else {
        this.#container.start(this.#startOptions);
      }
    }
    this.#ensureMonitor();
  }

  async restoreAfterDurableObjectRestart(inactivityMs) {
    if (!this.#container.running) {
      return false;
    }
    await this.#container.setInactivityTimeout(inactivityMs);
    this.#ensureMonitor();
    return true;
  }

  async setInactivityTimeout(durationMs) {
    await this.#container.setInactivityTimeout(durationMs);
  }

  async waitUntilReady() {
    await this.#ready(this.#container.getTcpPort(this.#port));
  }

  async proxy(admission, { signal } = {}) {
    if (!this.#webSocketBridge) {
      throw new WebSocketBridgeUnavailableError();
    }
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError("Container proxy requires an AbortSignal.");
    }
    signal.throwIfAborted();
    const result = await this.#webSocketBridge.connect({
      admission,
      fetcher: this.#container.getTcpPort(this.#port),
      keepAliveMs: this.#keepAliveMs,
      signal,
    });
    const verified = assertVerifiedWebSocketBridgeResult(result);
    if (signal.aborted) {
      await verified.cancel("proxy_aborted_after_upgrade");
      signal.throwIfAborted();
    }
    return verified;
  }

  async stopGracefully() {
    if (!this.#container.running) {
      if (this.#monitoring) {
        await this.#monitoring;
      }
      return { status: "already-stopped" };
    }
    const stopped = this.#ensureMonitor();
    if (!this.#container.running) {
      await stopped;
      return { status: "already-stopped" };
    }
    try {
      this.#container.signal(SIGTERM);
    } catch (error) {
      if (this.#container.running) {
        throw error;
      }
    }
    await stopped;
    return { status: "stopped" };
  }

  async destroy(reason) {
    await this.#container.destroy(reason);
  }

  #ensureMonitor() {
    if (!this.#monitoring) {
      this.#monitoring = Promise.resolve(this.#container.monitor())
        .then(
          (result) => {
            this.#lifecycle.onExit?.(result);
            return result;
          },
          (error) => {
            this.#lifecycle.onError?.(error);
            throw error;
          },
        )
        .finally(() => {
          this.#monitoring = null;
        });
      void this.#monitoring.catch(() => undefined);
    }
    return this.#monitoring;
  }
}
