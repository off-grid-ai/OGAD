import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-rag-timestamps-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() }
}))

import {
  addRagMessage,
  createRagConversation,
  getDB,
  getRagMessages,
  normalizeLegacyTimestamps
} from '../database'

afterAll(() => {
  getDB().close()
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('chat row timestamps', () => {
  it('writes one canonical ISO form, so a local row never sorts above the synced rows before it', () => {
    const conversationId = createRagConversation('Timestamps')
    // A synced row, written earlier, in the ISO form the shared record carries.
    getDB()
      .prepare(
        `INSERT INTO rag_messages (uuid, conversation_id, role, content, created_at)
         VALUES ('synced-1', ?, 'assistant', 'earlier synced answer', '2026-09-02T17:17:05.446Z')`
      )
      .run(conversationId)
    addRagMessage(conversationId, 'assistant', 'Task stopped: Stopped')

    const rows = getRagMessages(conversationId)
    expect(rows.map((row) => row.content)).toEqual([
      'earlier synced answer',
      'Task stopped: Stopped'
    ])
    expect(rows[1]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('repairs rows written with CURRENT_TIMESTAMP once, and leaves canonical rows alone', () => {
    const conversationId = createRagConversation('Legacy')
    getDB()
      .prepare(
        `INSERT INTO rag_messages (uuid, conversation_id, role, content, created_at)
         VALUES ('legacy-1', ?, 'assistant', 'legacy row', '2026-09-02 17:39:00')`
      )
      .run(conversationId)
    expect(normalizeLegacyTimestamps(getDB())).toBeGreaterThanOrEqual(1)
    expect(getRagMessages(conversationId)[0]!.created_at).toBe('2026-09-02T17:39:00.000Z')
    expect(normalizeLegacyTimestamps(getDB())).toBe(0)
  })
})
