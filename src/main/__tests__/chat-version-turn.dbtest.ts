// A reply follows the turn it answers, not the version on screen when it finishes.
//
// The bug, as it happened in a God chat: you ask "are you there?", get an answer, retry it (two
// versions), ask a follow-up on version 2, then switch back to version 1 while the follow-up's
// answer is still streaming. When that answer was saved it took the thread on screen as its parent,
// so it appeared under version 1, after an answer it never followed, and hid version 1's arrows.
//
// This drives the real persistence path (addRagMessage, prepareAnswerVersion,
// selectRagMessageVersion, getRagMessages) against a real temp SQLite database.

import { describe, it, expect, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-version-turn-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

import * as db from '../database'

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

// A version chosen on screen is the one selected last; a real click is never in the same
// millisecond as the message before it, so each choice here waits for the clock to move.
const nextMillisecond = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2))

const shown = (conversationId: string): string[] =>
  db.getRagMessages(conversationId).map((message) => message.content)

describe('a reply saved after switching versions', () => {
  it('stays in the thread of the question it answers', async () => {
    const chat = db.createRagConversation('version-turn', 'Versions')
    db.addRagMessage(chat, 'user', 'are you there?')
    const first = db.addRagMessage(chat, 'assistant', 'star')

    // Retry: a second version of the answer, then a follow-up asked on it.
    expect(db.prepareAnswerVersion(chat, first.uuid)).toBe(true)
    const second = db.addRagMessage(chat, 'assistant', 'I am ever here')
    db.addRagMessage(chat, 'user', 'Ask for specific assistance')
    expect(shown(chat)).toEqual(['are you there?', 'I am ever here', 'Ask for specific assistance'])

    // Back to version 1 while the follow-up is still being answered.
    await nextMillisecond()
    expect(db.selectRagMessageVersion(chat, second.uuid, -1)).toBe(true)
    expect(shown(chat)).toEqual(['are you there?', 'star'])

    // The answer finishes now. It belongs to the follow-up, so version 1 is unchanged...
    db.addRagMessage(chat, 'assistant', 'Hark')
    expect(shown(chat)).toEqual(['are you there?', 'star'])

    // ...and version 2 carries its whole thread, the answer included.
    await nextMillisecond()
    expect(db.selectRagMessageVersion(chat, first.uuid, 1)).toBe(true)
    expect(shown(chat)).toEqual([
      'are you there?',
      'I am ever here',
      'Ask for specific assistance',
      'Hark'
    ])
  })
})
