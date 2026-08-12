// Deleting a project removes project-owned data while preserving chat history (real temp SQLite).
//
// Product outcome: the project, knowledge, and generated artifacts are gone. Its
// conversations move back to unfiled Chat with every message intact.
//
// Integration over the REAL data layer: seed via the REAL insert paths
// (createProject, createRagConversation, addRagMessage, saveArtifact), run the
// REAL deleteProject (the projects:delete handler is a one-liner over it), assert
// the terminal artifact — surviving rows + artifact files. Only Electron's
// userData dir + safeStorage are faked (the true boundaries).

import { describe, it, expect, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-projdel-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

import * as dbmod from '../database'
import { createProject, deleteProject } from '../rag/store'
import { saveArtifact, listArtifacts } from '../artifacts'

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

describe('deleteProject', () => {
  it('unfiles chats and preserves their messages while removing project-owned artifacts', () => {
    createProject({ id: 'p1', name: 'Roadmap' })
    dbmod.createRagConversation('c1', 'Planning chat', 'p1') // a PROJECT-scoped chat
    dbmod.addRagMessage('c1', 'user', 'what is next?')
    dbmod.addRagMessage('c1', 'assistant', 'ship the fix')
    saveArtifact({
      kind: 'text',
      code: 'the plan',
      title: 'Plan',
      conversationId: 'c1',
      projectId: 'p1'
    })

    // Precondition: the chat, its messages, and the artifact are really there.
    expect(count('SELECT COUNT(*) AS c FROM rag_conversations WHERE project_id = ?', 'p1')).toBe(1)
    expect(count('SELECT COUNT(*) AS c FROM rag_messages WHERE conversation_id = ?', 'c1')).toBe(2)
    expect(listArtifacts({ projectId: 'p1' }).length).toBe(1)

    deleteProject('p1')

    expect(count('SELECT COUNT(*) AS c FROM projects WHERE id = ?', 'p1')).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM rag_conversations WHERE project_id = ?', 'p1')).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM rag_conversations WHERE id = ?', 'c1')).toBe(1)
    expect(count('SELECT COUNT(*) AS c FROM rag_messages WHERE conversation_id = ?', 'c1')).toBe(2)
    expect(listArtifacts({ projectId: 'p1' }).length).toBe(0)
  })
})
