export class BuildGenerations<T> {
  private requested = 0
  private accepted: { generation: number; value: T } | null = null

  request(): number { return ++this.requested }
  current(): number { return this.requested }
  good(): { generation: number; value: T } | null { return this.accepted }
  accept(generation: number, value: T): boolean {
    if (generation !== this.requested) return false
    this.accepted = { generation, value }
    return true
  }
}
