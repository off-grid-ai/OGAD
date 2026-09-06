/**
 * Real SQLite coverage for the task -> Chat projection writer. The decisions (which statuses post,
 * the copy) are shared's; this checks that the desktop writer posts once, edits in place, deletes
 * when a task leaves a user-relevant state, and stays silent for Chats it cannot find.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-result-chat-writer-'))

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

import { createRagConversation, getDB, getRagMessages } from '../../database'
import { persistTaskResultInChat } from '../task-result-chat'
import type { TaskRunSnapshot } from '../task-history-store'

afterAll(() => {
  getDB().close()
  fs.rmSync(profile, { recursive: true, force: true })
})

function task(overrides: Partial<TaskRunSnapshot>): TaskRunSnapshot {
  return {
    taskId: 'task-a',
    journeyId: 'chat-a',
    kind: 'web_use',
    title: 'Find the invoice',
    status: 'running',
    steps: [],
    startedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('persistTaskResultInChat', () => {
  it('posts nothing when the task has no Chat of its own', () => {
    const db = getDB()
    expect(persistTaskResultInChat(db, task({ journeyId: 'task-a' }))).toBe(false)
    expect(persistTaskResultInChat(db, task({ journeyId: '   ' }))).toBe(false)
  })

  it('posts nothing when the Chat does not exist in this database', () => {
    expect(
      persistTaskResultInChat(
        getDB(),
        task({ journeyId: 'no-such-chat', status: 'done', summary: 'Done.' })
      )
    ).toBe(false)
  })

  it('posts once, edits in place, ignores repeats, and deletes when the task goes quiet', () => {
    const db = getDB()
    createRagConversation('chat-a', 'Invoice task')

    expect(persistTaskResultInChat(db, task({ status: 'running' }))).toBe(false)
    expect(getRagMessages('chat-a')).toHaveLength(0)

    expect(
      persistTaskResultInChat(
        db,
        task({ status: 'done', summary: 'Invoice found.', lastUrl: 'https://example.com/inv' })
      )
    ).toBe(true)
    let messages = getRagMessages('chat-a')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('assistant')
    expect(messages[0]?.content).toContain('Invoice found.')
    expect(messages[0]?.content).toContain('https://example.com/inv')

    expect(
      persistTaskResultInChat(
        db,
        task({ status: 'done', summary: 'Invoice found.', lastUrl: 'https://example.com/inv' })
      )
    ).toBe(false)
    expect(getRagMessages('chat-a')).toHaveLength(1)

    expect(
      persistTaskResultInChat(db, task({ status: 'failed', summary: 'Login required.' }))
    ).toBe(true)
    messages = getRagMessages('chat-a')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toBe('Task failed: Login required.')

    expect(persistTaskResultInChat(db, task({ status: 'running' }))).toBe(true)
    expect(getRagMessages('chat-a')).toHaveLength(0)
    expect(persistTaskResultInChat(db, task({ status: 'running' }))).toBe(false)
  })

  it('keeps one message per task inside a shared Chat', () => {
    const db = getDB()
    createRagConversation('chat-b', 'Two tasks')
    expect(
      persistTaskResultInChat(
        db,
        task({ taskId: 't1', journeyId: 'chat-b', status: 'done', summary: 'One.' })
      )
    ).toBe(true)
    expect(
      persistTaskResultInChat(
        db,
        task({ taskId: 't2', journeyId: 'chat-b', status: 'stopped', summary: 'Two.' })
      )
    ).toBe(true)
    expect(
      persistTaskResultInChat(
        db,
        task({ taskId: 't1', journeyId: 'chat-b', status: 'done', summary: 'One again.' })
      )
    ).toBe(true)
    const contents = getRagMessages('chat-b')
      .map((m) => m.content)
      .sort()
    expect(contents).toEqual(['One again.', 'Task stopped: Two.'])
  })
})
