import { expect, it } from 'vitest'
import { createChatDraftStore } from '../../components/chat-draft-store'
import { createChatQueueStore, CHAT_QUEUE_SETTINGS_KEY, type QueuedTurn } from '../chat-queue-store'
import { submitQueuedTurn } from '../chat-queue-submit'
import {
  MAX_PASTED_ATTACHMENT_TEXT_CHARS,
  MAX_PERSISTED_QUEUE_BYTES,
  persistedChatQueues
} from '../chat-queue-persistence'

const item: QueuedTurn = {
  text: 'Read this',
  mode: 'ask',
  projectId: null,
  atts: [
    {
      id: 'file',
      name: 'notes.pdf',
      kind: 'pdf',
      path: '/uploads/notes.pdf',
      text: 'Extracted text',
      preview: 'data:image/png;base64,large',
      status: 'ready',
      mimeType: 'application/pdf',
      fileSize: 42
    }
  ]
}
it('persists file references without previews or extracted text', () => {
  const saved = persistedChatQueues({ a: [item] })
  expect(JSON.parse(JSON.stringify(saved))).toEqual({
    a: [
      {
        text: 'Read this',
        mode: 'ask',
        projectId: null,
        atts: [
          {
            id: 'file',
            name: 'notes.pdf',
            kind: 'pdf',
            path: '/uploads/notes.pdf',
            mimeType: 'application/pdf',
            fileSize: 42
          }
        ]
      }
    ]
  })
})
it('reloads file contents through the existing upload loader', async () => {
  const reads: string[] = []
  const extracted: string[] = []
  const store = createChatQueueStore({
    getSettings: async () => ({ [CHAT_QUEUE_SETTINGS_KEY]: persistedChatQueues({ a: [item] }) }),
    saveSetting: async () => {},
    fileDataUrl: async (path) => {
      reads.push(path)
      return 'data:text/plain;base64,aGVsbG8='
    },
    processFile: async (bytes, name) => {
      extracted.push(`${name}:${new TextDecoder().decode(bytes)}`)
      return { kind: 'pdf', text: 'Reloaded text', path: '/new-copy.pdf' }
    }
  })
  await store.ready
  expect(reads).toEqual(['/uploads/notes.pdf'])
  expect(extracted).toEqual(['notes.pdf:hello'])
  expect(store.ref.current.a![0]!.atts[0]).toMatchObject({
    path: '/uploads/notes.pdf',
    text: 'Reloaded text',
    status: 'ready'
  })
})
it('restores missing files with an attachment error while keeping the queued text', async () => {
  const store = createChatQueueStore({
    getSettings: async () => ({ [CHAT_QUEUE_SETTINGS_KEY]: persistedChatQueues({ a: [item] }) }),
    saveSetting: async () => {},
    fileDataUrl: async () => null
  })
  await store.ready
  expect(store.ref.current.a![0]).toMatchObject({
    text: item.text,
    atts: [{ text: '', status: 'error', error: 'Attachment missing. Attach the file again.' }]
  })
})
it('caps pasted text and never persists its preview', () => {
  const pasted: QueuedTurn = {
    ...item,
    atts: [
      {
        id: 'paste',
        name: 'paste',
        kind: 'pasted',
        text: 'x'.repeat(MAX_PASTED_ATTACHMENT_TEXT_CHARS + 1),
        preview: 'large',
        status: 'ready'
      }
    ]
  }
  const saved = persistedChatQueues({ a: [pasted] }).a![0]!.atts[0]!
  expect(saved.text).toBe('x'.repeat(MAX_PASTED_ATTACHMENT_TEXT_CHARS))
  expect(saved).not.toHaveProperty('preview')
})
it('keeps over-cap text in the composer and does not queue or persist it', async () => {
  let saved: unknown
  const store = createChatQueueStore({
    getSettings: async () => ({}),
    saveSetting: async (_key, value) => {
      saved = value
    }
  })
  await store.ready
  await store.publish({ a: [{ ...item, atts: [] }] })
  const text = '😀'.repeat(MAX_PERSISTED_QUEUE_BYTES / 4)
  const draftStore = createChatDraftStore('Other draft')
  let cleared = false
  let stopped = false
  expect(
    await submitQueuedTurn(
      store,
      'a',
      new Set(['a']),
      { ...item, text, atts: [] },
      {
        draftStore,
        sendNow: true,
        clearDraft: () => {
          cleared = true
        },
        stop: async () => {
          stopped = true
        }
      }
    )
  ).toBe(true)
  expect(draftStore.getSnapshot()).toBe(`Other draft\n${text}`)
  expect(cleared).toBe(false)
  expect(stopped).toBe(false)
  expect(store.ref.current.a).toHaveLength(1)
  expect(saved).toEqual(persistedChatQueues({ a: [{ ...item, atts: [] }] }))
})
