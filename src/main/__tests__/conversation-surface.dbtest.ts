/**
 * Conversations know their screen: Chat or God. Real database and settings store; Electron's
 * userData directory and its encryption are the only boundaries replaced. Synthetic data.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-surface-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: { handle: () => undefined },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import { createRagConversation, getRagConversations } from '../database'

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('conversation surface', () => {
  it("lists God's conversations on God and leaves them out of Chat", () => {
    createRagConversation('chat-1', 'Trip ideas')
    createRagConversation('god-1', 'What is on today?', null, 'god')

    const ids = (surface?: 'chat' | 'god'): string[] =>
      getRagConversations(undefined, undefined, surface).map((c) => c.id)
    expect(ids('god')).toEqual(['god-1'])
    expect(ids('chat')).toContain('chat-1')
    expect(ids('chat')).not.toContain('god-1')
    // Asking for no surface keeps every conversation, as before.
    expect(ids()).toEqual(expect.arrayContaining(['chat-1', 'god-1']))
  })
})
