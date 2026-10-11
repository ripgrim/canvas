const ADMISSION_KEYS = new Set([
  "clientId",
  "connectionId",
  "correlationId",
  "fileId",
  "generationId",
  "protocolEpoch",
  "roomCapability",
  "subjectId",
  "role",
  "accessEpoch",
  "authorityContext",
  "transport",
]);

const BYTE_LIKE_KEYS = /^(body|bytes|document|documentBytes|payload|snapshot|update)$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;
const ROLES = new Set(["owner", "viewer"]);

function assertAuthorityContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Coordinator admission requires authority context.");
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("fence") || !keys.includes("leaseOwnerId")) {
    throw new TypeError("Authority context requires only fence and leaseOwnerId.");
  }
  if (!Number.isSafeInteger(value.fence) || value.fence <= 0) {
    throw new TypeError("Authority fence must be a positive safe integer.");
  }
  if (
    typeof value.leaseOwnerId !== "string" ||
    !IDENTIFIER_PATTERN.test(value.leaseOwnerId)
  ) {
    throw new TypeError("Authority leaseOwnerId must be a bounded identifier.");
  }
  return Object.freeze({ fence: value.fence, leaseOwnerId: value.leaseOwnerId });
}

function isByteContainer(value) {
  return (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== "undefined" && value instanceof Blob)
  );
}

export function assertCoordinatorAdmission(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Coordinator admission must be metadata.");
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!ADMISSION_KEYS.has(key) || BYTE_LIKE_KEYS.test(key) || isByteContainer(entry)) {
      throw new TypeError(`Coordinator cannot retain document data in '${key}'.`);
    }
    if (key === "authorityContext") {
      continue;
    }
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 128) {
      throw new TypeError(`Coordinator metadata '${key}' must be a non-empty string.`);
    }
    if (key === "roomCapability") {
      if (!CAPABILITY_PATTERN.test(entry)) {
        throw new TypeError("Room capability must be bounded opaque base64url data.");
      }
      continue;
    }
    if (key !== "transport" && key !== "role" && !IDENTIFIER_PATTERN.test(entry)) {
      throw new TypeError(`Coordinator metadata '${key}' is not a valid bounded identifier.`);
    }
  }
  for (const key of ADMISSION_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`Coordinator admission is missing '${key}'.`);
    }
  }
  if (value.transport !== "websocket") {
    throw new TypeError("Coordinator admissions require the WebSocket transport.");
  }
  if (!ROLES.has(value.role)) {
    throw new TypeError("Coordinator admission role must be owner or viewer.");
  }
  const authorityContext = assertAuthorityContext(value.authorityContext);
  return Object.freeze({ ...value, authorityContext });
}

export function assertMetadataOnly(value, path = "state") {
  if (isByteContainer(value)) {
    throw new TypeError(`Coordinator retained document bytes at '${path}'.`);
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (BYTE_LIKE_KEYS.test(key)) {
      throw new TypeError(`Coordinator retained document data at '${path}.${key}'.`);
    }
    assertMetadataOnly(entry, `${path}.${key}`);
  }
}
