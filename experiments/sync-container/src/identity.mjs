const PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function requirePart(label, value) {
  if (typeof value !== "string" || !PART_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a non-empty room identity part.`);
  }
  return value;
}

export function createRoomIdentity({ protocolEpoch, fileId, generationId }) {
  return [
    "sync",
    requirePart("protocolEpoch", protocolEpoch),
    requirePart("fileId", fileId),
    requirePart("generationId", generationId),
  ].join(":");
}

export function parseRoomIdentity(identity) {
  if (typeof identity !== "string") {
    throw new TypeError("Room identity must be a string.");
  }
  const parts = identity.split(":");
  const [namespace, protocolEpoch, fileId, generationId] = parts;
  if (namespace !== "sync" || parts.length !== 4) {
    throw new TypeError("Room identity must include protocol epoch, file, and generation.");
  }
  return {
    protocolEpoch: requirePart("protocolEpoch", protocolEpoch),
    fileId: requirePart("fileId", fileId),
    generationId: requirePart("generationId", generationId),
  };
}
