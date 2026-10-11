const PLATFORM_PATTERN = /^(?:electron|web)$/;
const APP_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PHASE_PATTERN = /^[a-z][a-z0-9]*(?::[a-z][a-z0-9-]*)*$/;
const PROTOCOL_EPOCH_PATTERN = /^v[1-9][0-9]{0,5}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]*$/;
const SENSITIVE_KEY_PATTERN = /(api.?key|authorization|bearer|capability|cookie|credential|document|operation|password|payload|secret|session|source.?patch|ticket|token)/i;
const ERROR_PHASE_PATTERN = /(error|failed|rejected)/i;
const ALLOWED_KEYS = new Set([
  "activeConnections",
  "appPlatform",
  "appVersion",
  "attempt",
  "authority",
  "connectionId",
  "correlationId",
  "errorCode",
  "errorName",
  "fence",
  "generation",
  "graceMs",
  "phase",
  "protocolEpoch",
  "queueDepth",
  "reason",
  "requestId",
  "roomId",
]);

function assertNoSensitiveFields(value, path = "event", seen = new Set()) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    throw new TypeError("Sync event cannot contain cyclic data.");
  }
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new TypeError(`Sync event cannot contain sensitive field '${path}.${key}'.`);
    }
    assertNoSensitiveFields(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function copyAllowlistedEvent(event) {
  const copied = {};
  for (const [key, value] of Object.entries(event)) {
    if (!ALLOWED_KEYS.has(key) || value === undefined) {
      continue;
    }
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new TypeError(`Sync event field '${key}' must be scalar.`);
    }
    copied[key] = value;
  }
  return copied;
}

function assertBoundedString(label, value, { maxLength, pattern }) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !pattern.test(value)
  ) {
    throw new TypeError(
      `Sync event ${label} must be a non-empty bounded string with valid syntax.`,
    );
  }
}

export class EventRecorder {
  #events = [];

  emit(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new TypeError("Sync event must be an object.");
    }
    assertNoSensitiveFields(event);
    const sanitized = copyAllowlistedEvent(event);
    assertBoundedString("appPlatform", sanitized.appPlatform, {
      maxLength: 16,
      pattern: PLATFORM_PATTERN,
    });
    assertBoundedString("appVersion", sanitized.appVersion, {
      maxLength: 64,
      pattern: APP_VERSION_PATTERN,
    });
    assertBoundedString("phase", sanitized.phase, {
      maxLength: 128,
      pattern: PHASE_PATTERN,
    });
    assertBoundedString("protocolEpoch", sanitized.protocolEpoch, {
      maxLength: 8,
      pattern: PROTOCOL_EPOCH_PATTERN,
    });
    assertBoundedString("generation", sanitized.generation, {
      maxLength: 128,
      pattern: IDENTIFIER_PATTERN,
    });
    if (sanitized.correlationId === undefined && sanitized.requestId === undefined) {
      throw new TypeError(
        "Sync events require correlationId or requestId.",
      );
    }
    if (sanitized.correlationId !== undefined) {
      assertBoundedString("correlationId", sanitized.correlationId, {
        maxLength: 256,
        pattern: REFERENCE_PATTERN,
      });
    }
    if (sanitized.requestId !== undefined) {
      assertBoundedString("requestId", sanitized.requestId, {
        maxLength: 256,
        pattern: REFERENCE_PATTERN,
      });
    }
    if (
      sanitized.fence !== undefined &&
      (!Number.isSafeInteger(sanitized.fence) || sanitized.fence <= 0)
    ) {
      throw new TypeError("Sync event fence must be a positive safe integer.");
    }
    if (sanitized.authority === true && sanitized.fence === undefined) {
      throw new TypeError("Authoritative sync events require a fence.");
    }
    if (sanitized.authority !== undefined && typeof sanitized.authority !== "boolean") {
      throw new TypeError("Sync event authority must be boolean when present.");
    }
    if (sanitized.errorCode !== undefined) {
      assertBoundedString("errorCode", sanitized.errorCode, {
        maxLength: 128,
        pattern: ERROR_CODE_PATTERN,
      });
    }
    if (ERROR_PHASE_PATTERN.test(sanitized.phase) && sanitized.errorCode === undefined) {
      throw new TypeError("Failed, rejected, and error sync events require errorCode.");
    }
    this.#events.push(Object.freeze({ at: Date.now(), ...sanitized }));
  }

  list() {
    return [...this.#events];
  }
}
