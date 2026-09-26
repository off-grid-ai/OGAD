import { AsyncLocalStorage } from 'node:async_hooks'

type ModelRole = 'chat' | 'decision' | 'grounding'
const evictors = new Map<ModelRole, () => Promise<void>>()
const exclusive = new AsyncLocalStorage<boolean>()

/** A low-memory task shares one model slot. Other tasks retain their residency policy. */
export function withExclusiveModelMemory<T>(task: () => Promise<T>): Promise<T> {
  if (exclusive.getStore()) return task()
  return exclusive.run(true, async () => {
    try {
      return await task()
    } finally {
      // Leave chat available for its next use without eagerly loading it.
      await prepareModelMemory('chat')
    }
  })
}

export function registerModelEvictor(role: ModelRole, evict: () => Promise<void>): void {
  evictors.set(role, evict)
}

/** Await process exit before allocating the next model, including nested tool calls. */
export async function prepareModelMemory(role: ModelRole): Promise<void> {
  if (!exclusive.getStore()) return
  for (const [other, evict] of evictors) {
    if (other !== role) await evict()
  }
}
