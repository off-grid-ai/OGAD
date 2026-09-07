const listeners = new Set<() => void>()

/** The active image route is runtime state, separate from committed image preferences. */
export function publishActiveImageModelChanged(): void {
  for (const listener of listeners) listener()
}

export function subscribeActiveImageModel(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
