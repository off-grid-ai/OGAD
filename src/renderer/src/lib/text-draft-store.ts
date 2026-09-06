/**
 * One owner for a text draft the user is still typing.
 *
 * A draft held in component state makes every keystroke a render of whatever owns that state -
 * in the chat composer's case a 7000-line tree, in the settings panel's case the tab plus the
 * chat behind it. The draft lives here instead, and only the field that subscribes rerenders.
 * The store is deliberately dumb: it holds the current text and tells its subscribers it
 * changed. Nothing about when a draft is committed or persisted belongs here.
 */
export interface TextDraftStore {
  getSnapshot: () => string
  set: (value: string) => void
  update: (updater: (current: string) => string) => void
  subscribe: (listener: () => void) => () => void
}

export function createTextDraftStore(initialValue = ''): TextDraftStore {
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
