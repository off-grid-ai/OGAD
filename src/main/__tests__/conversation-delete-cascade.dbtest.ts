// D23 — deleting a conversation must remove its messages AND its generated
// artifacts, not orphan them. deleteRagConversation deleted only the
// rag_conversations row: rag_messages orphaned (FKs are off, so the ON DELETE
// CASCADE never fired) and artifacts (keyed by conversationId) lingered in the
// library forever, still openable, growing disk.
//
// Integration over the REAL data layer + REAL artifact files: seed a conversation,
// its messages, and an artifact via their REAL insert paths, then run the exact two
// calls the rag:delete-conversation handler makes (deleteArtifactsForConversation +
// deleteRagConversation), and assert the terminal artifact — surviving rows + files.

import { describe, it, expect, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-convdel-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

import * as dbmod from '../database'
import { saveArtifact, listArtifacts, deleteArtifactsForConversation } from '../artifacts'

const count = (sql: string, ...args: unknown[]): number =>
  (
    dbmod
      .getDB()
      .prepare(sql)
      .get(...args) as { c: number }
  ).c

afterAll(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('deleting a conversation removes its messages + artifacts (D23)', () => {
  it('leaves no orphaned rag_messages or artifacts', () => {
    dbmod.createRagConversation('c1', 'A chat', null)
    dbmod.addRagMessage('c1', 'user', 'make me a chart')
    dbmod.addRagMessage('c1', 'assistant', 'here')
    dbmod.writeChatSessionTurns('c1', [
      {
        id: 'turn-c1',
        conversationId: 'c1',
        userMessage: { role: 'user', content: 'make me a chart' },
        status: 'completed',
        request: { operation: { type: 'text' }, request: {} }
      }
    ])
    saveArtifact({ kind: 'text', code: 'chart code', title: 'Chart', conversationId: 'c1' })

    // Precondition: the messages + artifact are really there.
    expect(count('SELECT COUNT(*) AS c FROM rag_messages WHERE conversation_id = ?', 'c1')).toBe(2)
    expect(count('SELECT COUNT(*) AS c FROM chat_session_turns WHERE conversation_id = ?', 'c1')).toBe(1)
    expect(listArtifacts({ conversationId: 'c1' }).length).toBe(1)

    // Exactly what the rag:delete-conversation handler does.
    deleteArtifactsForConversation('c1')
    dbmod.deleteRagConversation('c1')

    // Terminal artifact: nothing scoped to the deleted conversation survives.
    expect(count('SELECT COUNT(*) AS c FROM rag_conversations WHERE id = ?', 'c1')).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM rag_messages WHERE conversation_id = ?', 'c1')).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM chat_session_turns WHERE conversation_id = ?', 'c1')).toBe(0)
    expect(listArtifacts({ conversationId: 'c1' }).length).toBe(0)
  })
})
