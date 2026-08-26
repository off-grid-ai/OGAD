/** In-memory source of truth for a live task's current objective. The original
 * request is immutable; accepted guidance is additive and remains private. */
export class CurrentTaskBrief {
  private readonly accepted: string[] = []

  constructor(readonly originalRequest: string) {}

  accept(items: readonly string[]): void {
    for (const item of items) {
      const guidance = item.trim()
      if (guidance) this.accepted.push(guidance)
    }
  }

  get guidance(): readonly string[] {
    return this.accepted
  }

  get objective(): string {
    if (!this.accepted.length) return this.originalRequest
    return [
      `Original request: ${this.originalRequest}`,
      'Accepted guidance (authoritative; later items override conflicting earlier items):',
      ...this.accepted.map((item, index) => `${index + 1}. ${item}`)
    ].join('\n')
  }
}
