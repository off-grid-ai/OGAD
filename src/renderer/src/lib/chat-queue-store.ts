import {
  MAX_PASTED_ATTACHMENT_TEXT_CHARS,
  persistedChatQueues,
  reloadQueueAttachments,
  type QueuedAttachmentReference,
  type QueueAttachmentLoader
} from './chat-queue-persistence'
import { createQueueDrainer } from './chat-queue-drain'
import type { ChatQueues } from './chat-queue-types'
export type { ChatQueues, QueuedTurn } from './chat-queue-types'
export const CHAT_QUEUE_SETTINGS_KEY = 'chatQueuedMessages'
interface QueueStorage extends QueueAttachmentLoader {
  getSettings(): Promise<Record<string, unknown>>
  saveSetting(key: string, value: unknown): Promise<unknown>
}

/** Validate durable input before it reaches sendMessage. */
export function restoreChatQueues(raw: unknown): ChatQueues {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw).flatMap(([id, items]) => {
      if (!Array.isArray(items)) return []
      const valid = items.filter(
        (item) =>
          item &&
          typeof item.text === 'string' &&
          Array.isArray(item.atts) &&
          item.atts.every((attachment: unknown) => {
            if (!attachment || typeof attachment !== 'object') return false
            const att = attachment as Record<string, unknown>
            return (
              typeof att.id === 'string' &&
              typeof att.name === 'string' &&
              ['text', 'pdf', 'docx', 'image', 'audio', 'video', 'pasted'].includes(
                String(att.kind)
              ) &&
              (att.path === undefined || typeof att.path === 'string') &&
              (att.text === undefined || typeof att.text === 'string')
            )
          }) &&
          (item.projectId === null || typeof item.projectId === 'string') &&
          (item.mode === 'ask' || item.mode === 'image')
      )
      return valid.length
        ? [
            [
              id,
              valid.map((item) => ({
                ...item,
                atts: item.atts.map((att: QueuedAttachmentReference) => ({
                  id: att.id,
                  name: att.name,
                  kind: att.kind,
                  path: att.path,
                  ...(att.mimeType !== undefined ? { mimeType: att.mimeType } : {}),
                  ...(att.fileSize !== undefined ? { fileSize: att.fileSize } : {}),
                  text: att.path ? '' : (att.text ?? '').slice(0, MAX_PASTED_ATTACHMENT_TEXT_CHARS),
                  status: 'ready'
                }))
              }))
            ]
          ]
        : []
    })
  )
}

/** Shared by mounted observers and senders; transfers never erase durable queues. */
export interface ChatQueueStore {
  ref: { current: ChatQueues }
  ready: Promise<void>
  drain: ReturnType<typeof createQueueDrainer>
  subscribe: (listener: (queues: ChatQueues) => void) => () => void
  publish: (queues: ChatQueues) => Promise<void>
  flush: () => Promise<void>
}
export function createChatQueueStore(storage: QueueStorage): ChatQueueStore {
  const ref: { current: ChatQueues } = { current: {} }
  const listeners = new Set<(queues: ChatQueues) => void>()
  let writes = Promise.resolve()
  const ready = storage.getSettings().then(async (settings) => {
    ref.current = await reloadQueueAttachments(
      restoreChatQueues(settings[CHAT_QUEUE_SETTINGS_KEY]),
      storage
    )
    for (const listener of listeners) listener(ref.current)
  })
  return {
    ref,
    ready,
    drain: createQueueDrainer((callback) => setTimeout(callback, 30)),
    subscribe(listener: (queues: ChatQueues) => void) {
      listeners.add(listener)
      listener(ref.current)
      return () => {
        listeners.delete(listener)
      }
    },
    publish(queues: ChatQueues) {
      ref.current = queues
      for (const listener of listeners) listener(queues)
      // Take a snapshot now; later ref mutations must not change a queued write.
      const snapshot = persistedChatQueues(queues)
      writes = writes
        .catch(() => {})
        .then(async () => {
          await ready
          await storage.saveSetting(CHAT_QUEUE_SETTINGS_KEY, snapshot)
        })
      return writes
    },
    flush: () => writes
  }
}
const stores = new WeakMap<object, ReturnType<typeof createChatQueueStore>>()
export function getChatQueueStore(storage: QueueStorage): ChatQueueStore {
  let store = stores.get(storage)
  if (!store) {
    store = createChatQueueStore(storage)
    stores.set(storage, store)
  }
  return store
}
