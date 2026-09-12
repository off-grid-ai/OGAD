export interface ChatDraftStore {
  getSnapshot: () => string
  set: (value: string) => void
  update: (updater: (current: string) => string) => void
  subscribe: (listener: () => void) => () => void
}

export function createChatDraftStore(initialValue = ''): ChatDraftStore {
  let value = initialValue
  const listeners = new Set<() => void>()

  const set = (nextValue: string): void => {
    if (nextValue === value) return
    value = nextValue
    for (const listener of listeners) listener()
  }

  return {
    getSnapshot: () => value,
    set,
    update: (updater) => set(updater(value)),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
