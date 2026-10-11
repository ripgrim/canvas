export class ManualScheduler {
  #now = 0;
  #nextId = 1;
  #tasks = new Map();

  schedule(delayMs, task) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("Delay must be a non-negative number.");
    }
    const id = this.#nextId++;
    this.#tasks.set(id, { dueAt: this.#now + delayMs, task });
    return id;
  }

  cancel(id) {
    return this.#tasks.delete(id);
  }

  async advanceBy(deltaMs) {
    this.#now += deltaMs;
    const due = [...this.#tasks.entries()]
      .filter(([, task]) => task.dueAt <= this.#now)
      .sort((left, right) => left[1].dueAt - right[1].dueAt);
    for (const [id, scheduled] of due) {
      this.#tasks.delete(id);
      await scheduled.task();
    }
  }

  get pendingCount() {
    return this.#tasks.size;
  }
}
