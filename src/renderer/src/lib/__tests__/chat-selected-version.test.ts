import fs from 'node:fs'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { projectSyncedMessageTurn } from '@offgrid/sync'
const h = vi.hoisted(() => ({
  profile: `/tmp/offgrid-selected-version-${process.pid}-${process.env.VITEST_POOL_ID ?? '0'}`
}))
vi.mock('electron', () => ({
  app: { getPath: () => h.profile, getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (value: Buffer) => value.toString()
  }
}))
import {
  addRagMessage,
  createRagConversation,
  getDB,
  getRagMessages,
  searchRagConversationIds,
  updateRagMessage,
  getSettings,
  saveSetting
} from '../../../../main/database'
import { registerHook, HOOKS } from '../../../../main/bootstrap/hookRegistry'
import type { SyncMutation } from '../../../../main/sync-mutation'
import { toBridgeConversation } from '../../../../main/extension-bridge/bridge-conversations'
import { answerVersion, selectAnswerVersion } from '../chat-versions'
import { createChatQueueStore } from '../chat-queue-store'
import type { ChatMessage } from '../../components/MemoryChat/types'
const previousDataDir = process.env.OFFGRID_DATA_DIR
beforeAll(() => {
  process.env.OFFGRID_DATA_DIR = h.profile
  fs.mkdirSync(h.profile, { recursive: true })
})
afterAll(() => {
  if (getDB().open) getDB().close()
  fs.rmSync(h.profile, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
})
it('writes selected content and context for bridge, sync, memory and search readers', () => {
  const cid = 'selected-answer-conversation'
  createRagConversation(cid, 'Test')
  const old: ChatMessage = {
    id: 'reply',
    role: 'assistant',
    content: 'selectedneedle',
    reasoning: 'Selected reasoning',
    context: { sources: [{ name: 'Selected source', position: 1, score: 1 }] }
  }
  const latest: ChatMessage = { id: 'reply', role: 'assistant', content: 'latestneedle' }
  const stored = addRagMessage(cid, 'assistant', latest.content)
  const selected = selectAnswerVersion(
    { ...latest, variants: [answerVersion(old), answerVersion(latest)], variantIndex: 1 },
    -1
  )
  let syncContent: string | undefined
  registerHook(HOOKS.syncRecordLocalMutation, (mutation: SyncMutation) => {
    if (mutation.entity === 'message')
      syncContent = getRagMessages(cid).find(
        (message) => message.uuid === mutation.entityId
      )?.content
  })
  expect(updateRagMessage(cid, stored.uuid, selected.content, selected.context)).toBe(true)
  const rows = getRagMessages(cid)
  expect(rows[0]!.content).toBe('selectedneedle')
  expect(syncContent).toBe('selectedneedle')
  expect(toBridgeConversation({ id: cid }, rows).turns[0]!.content).toBe('selectedneedle')
  const turn = projectSyncedMessageTurn({
    id: rows[0]!.uuid,
    role: 'assistant',
    content: rows[0]!.content,
    context: rows[0]!.context,
    createdAt: rows[0]!.created_at
  })!
  expect(turn.answer ?? turn.content).toBe('selectedneedle')
  expect(turn.reasoning).toBe('Selected reasoning')
  expect(searchRagConversationIds('selectedneedle')).toContain(cid)
  expect(searchRagConversationIds('latestneedle')).not.toContain(cid)
})
it('restores queued attachments through a real settings database reopen', async () => {
  const storage = {
    getSettings: async () => getSettings(),
    saveSetting: async (key: string, value: unknown) => saveSetting(key, value)
  }
  const first = createChatQueueStore(storage)
  await first.ready
  await first.publish({
    a: [
      {
        text: 'Durable queued turn',
        atts: [{ id: 'file', name: 'notes', kind: 'text', text: 'File contents', status: 'ready' }],
        mode: 'ask',
        projectId: null
      }
    ]
  })
  getDB().close()
  const restored = createChatQueueStore(storage)
  await restored.ready
  expect(restored.ref.current.a![0]).toMatchObject({
    text: 'Durable queued turn',
    atts: [{ text: 'File contents' }]
  })
})

it('turns legacy text-only versions into messages before bridge and search read a reopened database', () => {
  const cid = 'legacy-selected-answer'
  createRagConversation(cid, 'Legacy')
  // A message saved before versions were messages: its versions are a list inside the row.
  getDB()
    .prepare(
      `INSERT INTO rag_messages (uuid, conversation_id, role, content, context, created_at)
       VALUES ('legacy-selected-row', ?, 'assistant', 'legacynewneedle', ?, CURRENT_TIMESTAMP)`
    )
    .run(
      cid,
      JSON.stringify({
        variants: ['legacyoldneedle', 'legacynewneedle'],
        variantIndex: 0,
        reasoning: 'Newest reasoning'
      })
    )
  getDB().close()
  const rows = getRagMessages(cid)
  expect(rows[0]!.content).toBe('legacyoldneedle')
  expect(toBridgeConversation({ id: cid }, rows).turns[0]!.content).toBe('legacyoldneedle')
  expect(searchRagConversationIds('legacyoldneedle')).toContain(cid)
  // The other version is kept as its own message, so search still finds the chat by it.
  expect(searchRagConversationIds('legacynewneedle')).toContain(cid)
  expect(JSON.parse(rows[0]!.context!)).toHaveProperty('reasoning', 'Newest reasoning')
})
