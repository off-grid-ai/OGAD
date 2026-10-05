// The tab a browser offers for the web task it is about to ask for: its chat's tab, so the
// task works where the user is instead of opening a tab of its own. Pure.
//
// One offer per browser, taken once by the task that starts next, and only for a short while:
// an offer nobody takes never steers a later task.

/** How long an offer waits for its task to start. */
export const START_TAB_TTL_MS = 60_000

export interface StartTabs {
  offer(browserId: string, tabId: number): void
  /** Whether this browser has an offer waiting (the task should run in that browser). */
  has(browserId: string): boolean
  /** Takes this browser's offer, once. */
  take(browserId: string): number | null
}

export function createStartTabs(now: () => number): StartTabs {
  const offers = new Map<string, { tabId: number; at: number }>()
  const live = (browserId: string): { tabId: number; at: number } | undefined => {
    const offer = offers.get(browserId)
    if (offer && now() - offer.at > START_TAB_TTL_MS) {
      offers.delete(browserId)
      return undefined
    }
    return offer
  }
  return {
    offer: (browserId, tabId) => void offers.set(browserId, { tabId, at: now() }),
    has: (browserId) => live(browserId) !== undefined,
    take(browserId) {
      const offer = live(browserId)
      offers.delete(browserId)
      return offer?.tabId ?? null
    }
  }
}

/** The desktop's one registry. */
export const startTabs = createStartTabs(Date.now)
