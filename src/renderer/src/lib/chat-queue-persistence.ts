import type { Attachment } from '../components/MemoryChat/types'
import type { ChatQueues, QueuedTurn } from './chat-queue-types'

export const MAX_PERSISTED_QUEUE_BYTES = 256 * 1024
export const MAX_PASTED_ATTACHMENT_TEXT_CHARS = 16 * 1024
export type QueuedAttachmentReference = Pick<
  Attachment,
  'id' | 'name' | 'kind' | 'path' | 'mimeType' | 'fileSize'
> & { text?: string }
export type PersistedQueuedTurn = Omit<QueuedTurn, 'atts'> & { atts: QueuedAttachmentReference[] }

export function persistedQueuedTurn(item: QueuedTurn): PersistedQueuedTurn {
  return {
    text: item.text,
    projectId: item.projectId,
    mode: item.mode,
    assistantEnabled: item.assistantEnabled,
    atts: item.atts.map(({ id, name, kind, path, mimeType, fileSize, text }) => ({
      id,
      name,
      kind,
      path,
      mimeType,
      fileSize,
      ...(!path ? { text: text.slice(0, MAX_PASTED_ATTACHMENT_TEXT_CHARS) } : {})
    }))
  }
}
export function queueFits(items: readonly QueuedTurn[]): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(items.map(persistedQueuedTurn))).byteLength <=
    MAX_PERSISTED_QUEUE_BYTES
  )
}
export function persistedChatQueues(queues: ChatQueues): Record<string, PersistedQueuedTurn[]> {
  return Object.fromEntries(
    Object.entries(queues).map(([id, items]) => {
      const accepted: QueuedTurn[] = []
      for (const item of items) {
        if (queueFits([...accepted, item])) accepted.push(item)
      }
      return [id, accepted.map(persistedQueuedTurn)]
    })
  )
}

/** Reuse the upload reader and extractor; the original path remains the reference. */
export interface QueueAttachmentLoader {
  fileDataUrl?: (path: string) => Promise<string | null>
  processFile?: (
    bytes: ArrayBuffer,
    name: string
  ) => Promise<{
    kind: Attachment['kind']
    text: string
    path?: string
  }>
}
export async function reloadQueueAttachments(
  queues: ChatQueues,
  loader: QueueAttachmentLoader
): Promise<ChatQueues> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(queues).map(async ([id, items]) => [
        id,
        await Promise.all(
          items.map(async (item) => ({
            ...item,
            atts: await Promise.all(
              item.atts.map(async (att): Promise<Attachment> => {
                if (!att.path) return att
                try {
                  const data = await loader.fileDataUrl?.(att.path)
                  if (!data || !loader.processFile) throw new Error('Attachment missing')
                  const bytes = await (await fetch(data)).arrayBuffer()
                  const loaded = await loader.processFile(bytes, att.name)
                  return { ...att, kind: loaded.kind, text: loaded.text, status: 'ready' }
                } catch {
                  return {
                    ...att,
                    text: '',
                    status: 'error',
                    error: 'Attachment missing. Attach the file again.'
                  }
                }
              })
            )
          }))
        )
      ])
    )
  )
}
