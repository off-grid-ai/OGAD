import { queueFits } from './chat-queue-persistence'
import type { ChatDraftStore } from '../components/chat-draft-store'
import { enqueue, shouldQueue } from './chat-queue'
import type { ChatQueueStore, QueuedTurn } from './chat-queue-store'

/** Persist before clearing the composer; Stop is bound to the run captured at submission. */
export async function submitQueuedTurn(
  store: ChatQueueStore,
  cid: string | null,
  generating: ReadonlySet<string>,
  item: QueuedTurn,
  options: {
    draftStore?: ChatDraftStore
    sendNow?: boolean
    clearDraft?: () => void
    stop: () => Promise<void>
  }
): Promise<boolean> {
  await store.ready
  if (!cid || !shouldQueue(cid, generating)) return false
  const next = enqueue(store.ref.current, cid, item, options.sendNow)
  if (!queueFits(next[cid] ?? [])) {
    options.draftStore?.update((current) =>
      current.trim() === item.text ? current : `${current}${current ? '\n' : ''}${item.text}`
    )
    return true
  }
  await store.publish(next)
  options.clearDraft?.()
  if (options.sendNow) await options.stop()
  return true
}

export function queuedDraftAfterSave(current: string, submitted: string): string {
  return current.trim() === submitted ? '' : current
}
export function queuedAttachmentsAfterSave(
  current: QueuedTurn['atts'],
  submitted: QueuedTurn['atts']
): QueuedTurn['atts'] {
  const sentIds = new Set(submitted.map((attachment) => attachment.id))
  return current.filter((attachment) => !sentIds.has(attachment.id))
}
