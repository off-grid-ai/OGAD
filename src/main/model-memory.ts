import { AsyncLocalStorage } from 'node:async_hooks'
import { getResidencyMode } from './runtime-residency'

type ModelRole = 'chat' | 'decision' | 'grounding'
const evictors = new Map<ModelRole, () => Promise<void>>()
const exclusive = new AsyncLocalStorage<boolean>()
let activeTasks = 0
let taskCleanup: Promise<void> = Promise.resolve()

/** Keep specialists available for all steps, then release on-demand models. */
export async function withTaskModelMemory<T>(task: () => Promise<T>): Promise<T> {
  await taskCleanup
  activeTasks += 1
  try {
    return await task()
  } finally {
    activeTasks -= 1
    if (activeTasks === 0) {
      taskCleanup = (async () => {
        for (const role of ['grounding', 'decision'] as const) {
          if (getResidencyMode(role) === 'on-demand') await evictors.get(role)?.()
        }
      })().catch((error) => console.error('[model-memory] Task cleanup failed:', error))
      await taskCleanup
    }
  }
}

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

/** Unload a task model now (the Unload button). It reloads on its next use. False when no runtime
 *  for that role exists in this process. */
export async function unloadModelRole(role: 'decision' | 'grounding'): Promise<boolean> {
  const evict = evictors.get(role)
  if (!evict) return false
  await evict()
  return true
}

/** Await process exit before allocating the next model, including nested tool calls. */
export async function prepareModelMemory(role: ModelRole): Promise<void> {
  if (!exclusive.getStore()) return
  for (const [other, evict] of evictors) {
    if (other !== role) await evict()
  }
}
