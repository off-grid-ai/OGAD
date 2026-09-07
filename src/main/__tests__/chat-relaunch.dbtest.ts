/**
 * RELEASE_TEST_CHECKLIST #43 - conversation state survives a full database close/reopen.
 * The Electron profile and Keychain are native boundaries; every conversation and message
 * operation uses the production database API against a real disposable SQLite file.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-chat-relaunch-'))

vi.mock('electron', () => ({
  app: { getPath: () => profile },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import {
  addRagMessage,
  createRagConversation,
  getDB,
  getRagConversation,
  getRagConversations,
  getRagMessages,
  readChatSessionTurns,
  writeChatSessionTurns
} from '../database'

afterAll(() => {
  if (getDB().open) getDB().close()
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('chat persistence across relaunch', () => {
  it('reopens admitted Shared chat turns for lifecycle recovery', () => {
    const conversationId = 'release-chat-turn-recovery'
    createRagConversation(conversationId, 'Interrupted response')
    writeChatSessionTurns(conversationId, [
      {
        id: 'turn-a',
        conversationId,
        userMessage: { role: 'user', content: 'Finish this answer' },
        status: 'generating',
        request: { operation: { type: 'text' }, request: {} }
      }
    ])

    getDB().close()

    expect(readChatSessionTurns(conversationId)).toEqual([
      expect.objectContaining({ id: 'turn-a', status: 'generating' })
    ])
  })

  it('reopens the same conversation, ordered messages, and message context (#43)', () => {
    const conversationId = 'release-chat-relaunch'
    createRagConversation(conversationId, 'Release relaunch fixture')
    addRagMessage(conversationId, 'user', 'Remember the exact launch sequence', {
      scope: 'all-memory',
      attachments: [{ name: 'release-notes.md', kind: 'text' }]
    })
    addRagMessage(conversationId, 'assistant', 'The exact launch sequence is preserved.', {
      finishReason: 'stop'
    })

    getDB().close()

    expect(getDB().open).toBe(true)
    expect(getRagConversation(conversationId)).toEqual(
      expect.objectContaining({
        id: conversationId,
        title: 'Release relaunch fixture',
        project_id: null
      })
    )
    expect(getRagConversations()).toContainEqual(
      expect.objectContaining({ id: conversationId, message_count: 2 })
    )
    expect(getRagMessages(conversationId)).toEqual([
      expect.objectContaining({
        conversation_id: conversationId,
        role: 'user',
        content: 'Remember the exact launch sequence',
        context: JSON.stringify({
          scope: 'all-memory',
          attachments: [{ name: 'release-notes.md', kind: 'text' }]
        })
      }),
      expect.objectContaining({
        conversation_id: conversationId,
        role: 'assistant',
        content: 'The exact launch sequence is preserved.',
        context: JSON.stringify({ finishReason: 'stop' })
      })
    ])
  })
})
