/**
 * Core data owners emit one committed mutation contract for the private sync integration.
 *
 * The database, project store, transactions, UUID generation, and hook registry are real. Only
 * Electron's userData/safeStorage OS boundary points at a synthetic temp profile.
 */
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  userData: `/tmp/offgrid-sync-mutations-${process.pid}-${process.env.VITEST_POOL_ID ?? '0'}`
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import { registerHook, HOOKS } from '../bootstrap/hookRegistry'
import {
  addRagMessage,
  createRagConversation,
  deleteRagConversation,
  getDB,
  getRagConversation,
  setRagConversationProject,
  truncateRagMessages,
  updateRagConversationTitle
} from '../database'
import { createProject, deleteProject, updateProject } from '../rag/store'
import type { SyncMutation } from '../sync-mutation'

const mutations: SyncMutation[] = []

beforeAll(() => {
  fs.mkdirSync(h.userData, { recursive: true })
  registerHook(HOOKS.syncRecordLocalMutation, (mutation: SyncMutation) => {
    mutations.push(mutation)
  })
})

afterAll(() => {
  getDB().close()
  fs.rmSync(h.userData, { recursive: true, force: true })
})

describe('core sync mutation contract', () => {
  it('reports committed chat and project writes with stable cross-device ids', () => {
    createProject({ id: 'project-1', name: 'Shared project' })
    createRagConversation('conversation-1', 'First title', 'project-1')
    addRagMessage('conversation-1', 'user', 'hello')
    updateRagConversationTitle('conversation-1', 'Updated title')
    setRagConversationProject('conversation-1', null)
    updateProject('project-1', { name: 'Updated project' })

    expect(
      mutations.slice(0, 7).map(({ entity, entityId, kind }) => [entity, entityId, kind])
    ).toEqual([
      ['project', 'project-1', 'put'],
      ['conversation', 'conversation-1', 'put'],
      ['message', expect.stringMatching(/^[0-9a-f-]{36}$/), 'put'],
      ['conversation', 'conversation-1', 'put'],
      ['conversation', 'conversation-1', 'put'],
      ['conversation', 'conversation-1', 'put'],
      ['project', 'project-1', 'put']
    ])
  })

  it('reports child deletion and unfiling mutations when owners are removed', () => {
    mutations.length = 0
    createProject({ id: 'project-delete', name: 'Delete me' })
    createRagConversation('conversation-delete', 'Delete me', 'project-delete')
    addRagMessage('conversation-delete', 'user', 'one')
    addRagMessage('conversation-delete', 'assistant', 'two')
    addRagMessage('conversation-delete', 'user', 'three')

    mutations.length = 0
    expect(truncateRagMessages('conversation-delete', 1)).toBe(2)
    expect(mutations).toHaveLength(2)
    expect(mutations.every(({ entity, kind }) => entity === 'message' && kind === 'delete')).toBe(
      true
    )

    mutations.length = 0
    expect(deleteRagConversation('conversation-delete')).toBe(true)
    expect(mutations.map(({ entity, kind }) => [entity, kind])).toEqual([
      ['message', 'delete'],
      ['conversation', 'delete']
    ])

    createRagConversation('project-child', 'Project child', 'project-delete')
    addRagMessage('project-child', 'user', 'child')
    mutations.length = 0
    deleteProject('project-delete')
    expect(mutations.map(({ entity, kind }) => [entity, kind])).toEqual([
      ['conversation', 'put'],
      ['project', 'delete']
    ])
  })

  it('keeps a committed core write successful when the optional Pro hook fails', () => {
    const syncError = new Error('sync store unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    registerHook(HOOKS.syncRecordLocalMutation, () => {
      throw syncError
    })

    createRagConversation('conversation-offline', 'Saved locally')

    expect(getRagConversation('conversation-offline')).toMatchObject({
      id: 'conversation-offline',
      title: 'Saved locally'
    })
    expect(consoleError).toHaveBeenCalledWith(
      '[sync] Failed to record committed mutation',
      { entity: 'conversation', entityId: 'conversation-offline', kind: 'put' },
      syncError
    )
    consoleError.mockRestore()
  })
})
