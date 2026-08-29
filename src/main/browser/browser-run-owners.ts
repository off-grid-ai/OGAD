import type { VisionGuard } from '../vision/vision-guard'

export interface BrowserJourneyRunOwner {
  readonly journeyId: string
  readonly taskId: string
  readonly guard: VisionGuard
  readonly generation: number
  readonly controller: AbortController
}

/** One authoritative live browser run per Chat journey. */
export class BrowserJourneyRunOwners {
  private readonly owners = new Map<string, BrowserJourneyRunOwner>()
  private generation = 0

  replace(
    journeyId: string,
    taskId: string,
    guard: VisionGuard
  ): { owner: BrowserJourneyRunOwner; replaced?: BrowserJourneyRunOwner } {
    const replaced = this.owners.get(journeyId)
    if (replaced) {
      replaced.guard.halt('replaced by a newer task in this journey')
      replaced.controller.abort('replaced by a newer task in this journey')
    }
    const owner = {
      journeyId,
      taskId,
      guard,
      generation: ++this.generation,
      controller: new AbortController()
    }
    this.owners.set(journeyId, owner)
    return { owner, ...(replaced ? { replaced } : {}) }
  }

  isCurrent(owner: BrowserJourneyRunOwner): boolean {
    return this.owners.get(owner.journeyId) === owner
  }

  release(owner: BrowserJourneyRunOwner): void {
    if (this.isCurrent(owner)) this.owners.delete(owner.journeyId)
  }

  haltAll(reason: string): void {
    for (const owner of this.owners.values()) {
      owner.guard.halt(reason)
      owner.controller.abort(reason)
    }
    this.owners.clear()
  }
}
