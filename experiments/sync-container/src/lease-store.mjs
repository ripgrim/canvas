import { createHash } from "node:crypto";

export class StaleFenceError extends Error {
  constructor(message = "The room no longer owns the active lease.") {
    super(message);
    this.name = "StaleFenceError";
  }
}

export class MutationConflictError extends Error {
  constructor(mutationId) {
    super(`Mutation '${mutationId}' was reused with different content.`);
    this.name = "MutationConflictError";
    this.mutationId = mutationId;
  }
}

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Mutation numbers must be finite.");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError("Mutation content must be canonical JSON data.");
  }
  if (seen.has(value)) throw new TypeError("Mutation content cannot be cyclic.");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((entry) => canonicalize(entry, seen)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Mutation content must use plain objects.");
    }
    result = `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], seen)}`)
      .join(",")}}`;
  }
  seen.delete(value);
  return result;
}

export function mutationDigest(mutation) {
  return createHash("sha256").update(canonicalize(mutation)).digest("hex");
}

export class LeaseHeldError extends Error {
  constructor() {
    super("Another room generation owns an unexpired lease.");
    this.name = "LeaseHeldError";
  }
}

export class MemoryLeaseStore {
  #clock;
  #generations;
  #fence = 0;
  #leases = new Map();
  #released = new Set();
  #checkpoints = new Map();

  constructor({ generations, clock = () => Date.now() }) {
    this.#generations = generations;
    this.#clock = clock;
  }

  acquire(fileId, generationId, ttlMs) {
    this.#validateTtl(ttlMs);
    this.#generations.assertCurrent(fileId, generationId);
    const active = this.#leases.get(fileId);
    if (active && active.expiresAt > this.#clock()) {
      throw new LeaseHeldError();
    }
    const lease = Object.freeze({
      fileId,
      generationId,
      fence: ++this.#fence,
      expiresAt: this.#clock() + ttlMs,
    });
    this.#leases.set(fileId, lease);
    return lease;
  }

  renew(lease, ttlMs) {
    this.#validateTtl(ttlMs);
    this.assertOwner(lease);
    const renewed = Object.freeze({ ...lease, expiresAt: this.#clock() + ttlMs });
    this.#leases.set(lease.fileId, renewed);
    return renewed;
  }

  assertOwner(lease) {
    this.#generations.assertCurrent(lease.fileId, lease.generationId);
    const active = this.#leases.get(lease.fileId);
    if (
      !active ||
      active.generationId !== lease.generationId ||
      active.fence !== lease.fence ||
      active.expiresAt <= this.#clock()
    ) {
      throw new StaleFenceError();
    }
  }

  commitCheckpoint(lease, pointer) {
    this.assertOwner(lease);
    if (typeof pointer !== "string" || pointer.length === 0 || pointer.length > 512) {
      throw new TypeError("Checkpoint pointer must be a bounded non-empty string.");
    }
    const checkpoint = Object.freeze({
      fileId: lease.fileId,
      generationId: lease.generationId,
      fence: lease.fence,
      pointer,
    });
    this.#checkpoints.set(lease.fileId, checkpoint);
    return checkpoint;
  }

  readCheckpoint(fileId) {
    return this.#checkpoints.get(fileId) ?? null;
  }

  release(lease) {
    const releaseKey = `${lease.fileId}:${lease.generationId}:${lease.fence}`;
    if (this.#released.has(releaseKey)) {
      return false;
    }
    this.assertOwner(lease);
    this.#leases.delete(lease.fileId);
    this.#released.add(releaseKey);
    this.#generations.retire(lease.fileId, lease.generationId);
    return true;
  }

  expire(fileId) {
    const active = this.#leases.get(fileId);
    if (!active || active.expiresAt > this.#clock()) {
      return false;
    }
    this.#leases.delete(fileId);
    return true;
  }

  #validateTtl(ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("Lease TTL must be positive.");
    }
  }
}

export class MemoryMutationLog {
  #leaseStore;
  #records = [];
  #byId = new Map();

  constructor(leaseStore) {
    this.#leaseStore = leaseStore;
  }

  async append(lease, mutation) {
    this.#leaseStore.assertOwner(lease);
    if (!mutation || typeof mutation.id !== "string" || mutation.id.length === 0) {
      throw new TypeError("Mutation requires a non-empty string ID.");
    }
    const digest = mutationDigest(mutation);
    const existing = this.#byId.get(mutation.id);
    if (existing) {
      if (existing.digest !== digest) {
        throw new MutationConflictError(mutation.id);
      }
      return Object.freeze({ status: "replay", digest });
    }
    const record = Object.freeze({
      digest,
      lease: Object.freeze({ ...lease }),
      mutation: structuredClone(mutation),
    });
    this.#records.push(record);
    this.#byId.set(mutation.id, record);
    return Object.freeze({ status: "appended", digest });
  }

  has(mutationId) {
    return this.#byId.has(mutationId);
  }

  hasExact(mutation) {
    const existing = this.#byId.get(mutation?.id);
    return Boolean(existing && existing.digest === mutationDigest(mutation));
  }

  list() {
    return [...this.#records];
  }
}
