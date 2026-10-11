export class RetiredGenerationError extends Error {
  constructor(message = "This room generation is permanently retired.") {
    super(message);
    this.name = "RetiredGenerationError";
  }
}

export class NotCurrentGenerationError extends Error {
  constructor(message = "This is not the file's current room generation.") {
    super(message);
    this.name = "NotCurrentGenerationError";
  }
}

export class MemoryGenerationRegistry {
  #current = new Map();
  #retired = new Set();

  activate(fileId, generationId) {
    const key = this.#key(fileId, generationId);
    if (this.#retired.has(key)) {
      throw new RetiredGenerationError();
    }
    const current = this.#current.get(fileId);
    if (current && current !== generationId) {
      throw new NotCurrentGenerationError(
        "Retire the current generation before activating its replacement.",
      );
    }
    this.#current.set(fileId, generationId);
  }

  assertCurrent(fileId, generationId) {
    if (this.#retired.has(this.#key(fileId, generationId))) {
      throw new RetiredGenerationError();
    }
    if (this.#current.get(fileId) !== generationId) {
      throw new NotCurrentGenerationError();
    }
  }

  retire(fileId, generationId) {
    const key = this.#key(fileId, generationId);
    this.#retired.add(key);
    if (this.#current.get(fileId) === generationId) {
      this.#current.delete(fileId);
    }
  }

  resolveCurrent(fileId) {
    return this.#current.get(fileId) ?? null;
  }

  isRetired(fileId, generationId) {
    return this.#retired.has(this.#key(fileId, generationId));
  }

  #key(fileId, generationId) {
    return `${fileId}\u0000${generationId}`;
  }
}
