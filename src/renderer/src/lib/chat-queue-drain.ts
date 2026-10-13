import { dequeue } from './chat-queue'
import type { ChatQueues, QueuedTurn } from './chat-queue-types'

interface QueueDrainDependencies {
  queues: { current: ChatQueues }
  blocked: () => boolean
  publish: (queues: ChatQueues) => void
  send: (item: QueuedTurn) => void
}

/** Keep the item durable until the scheduled send starts. Coalesce duplicate settles. */
export function createQueueDrainer(
  schedule: (callback: () => void) => void
): (cid: string, dependencies: QueueDrainDependencies) => void {
  const pending = new Set<string>()
  return (cid: string, dependencies: QueueDrainDependencies): void => {
    if (pending.has(cid)) return
    pending.add(cid)
    schedule(() => {
      pending.delete(cid)
      if (dependencies.blocked()) return
      const { item, next } = dequeue(dependencies.queues.current, cid)
      if (!item) return
      dependencies.queues.current = next
      dependencies.publish(next)
      dependencies.send(item)
    })
  }
}
