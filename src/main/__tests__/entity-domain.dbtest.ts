import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-entity-domain-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import {
  addEntityFact,
  getDB,
  upsertEntitySession
} from '../database'
import {
  deleteEntityById,
  registerEntityDomain,
  resolveEntityCandidate,
  type EntityDomain
} from '../entity-domain'

function resolve(name: string, type = 'Unknown'): number {
  const result = resolveEntityCandidate({ name, type })
  if (!result.admitted) throw new Error(`Entity rejected: ${result.reason}`)
  return result.entityId
}

afterAll(() => {
  getDB().close()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('EntityDomain port', () => {
  it('lets a second implementation replace SQLite without caller type checks', () => {
    const calls: string[] = []
    const alternate: EntityDomain = {
      resolve(candidate) {
        calls.push(`resolve:${candidate.name}`)
        return {
          admitted: true,
          entityId: 4242,
          created: false,
          candidate: { ...candidate, type: candidate.type || 'Unknown' }
        }
      },
      delete(entityId) {
        calls.push(`delete:${entityId}`)
        return true
      }
    }
    const dispose = registerEntityDomain(alternate)
    try {
      expect(resolveEntityCandidate({ name: 'Alternate Entity' })).toMatchObject({
        admitted: true,
        entityId: 4242
      })
      expect(deleteEntityById(4242)).toBe(true)
      expect(calls).toEqual(['resolve:Alternate Entity', 'delete:4242'])
    } finally {
      dispose()
    }
  })

  it('rejects files and generic labels before the real database sees them', () => {
    const rejected = [
      ['entity-domain.ts', 'file'],
      ['API', 'generic'],
      ['Feature', 'generic'],
      ['Person', 'generic'],
      ['Project', 'generic'],
      ['Meeting', 'generic'],
      ['Task', 'generic'],
      ['User', 'generic'],
      ['Team', 'generic'],
      ['Thing', 'generic'],
      ['Things', 'generic'],
      ['Topic', 'generic'],
      ['Work', 'generic']
    ] as const

    for (const [name, reason] of rejected) {
      expect(resolveEntityCandidate({ name, type: 'Project' })).toEqual({
        admitted: false,
        reason
      })
      expect(
        getDB().prepare('SELECT COUNT(*) AS count FROM entities WHERE name = ?').get(name)
      ).toEqual({ count: 0 })
    }
  })

  it('normalizes and dedupes an admitted entity through the real database', () => {
    const first = resolveEntityCandidate({ name: '  Maya   Chen ', type: ' Person ' })
    const second = resolveEntityCandidate({ name: 'Maya Chen', type: 'Person' })
    expect(first).toMatchObject({ admitted: true, created: true })
    expect(second).toMatchObject({ admitted: true, created: false })
    if (!first.admitted || !second.admitted) throw new Error('expected admitted entities')
    expect(second.entityId).toBe(first.entityId)
  })
})

describe('EntityDomain SQLite lifecycle', () => {
  it('explicitly removes every core dependent while foreign keys are disabled', () => {
    const db = getDB()
    db.pragma('foreign_keys = OFF')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(0)
    try {
      db.prepare('INSERT INTO conversations (id, app_name) VALUES (?, ?)').run(
        'entity-delete-session',
        'Notes'
      )
      const doomed = resolve('Delete With Dependants', 'Person')
      const survivor = resolve('Lifecycle Survivor', 'Person')
      addEntityFact(doomed, 'Fact that must not become orphaned', 'entity-delete-session')
      upsertEntitySession(doomed, 'entity-delete-session')
      db.prepare(
        `INSERT INTO entity_edges
           (source_entity_id, target_entity_id, type, weight, evidence_count)
         VALUES (?, ?, 'cooccurrence', 1, 1)`
      ).run(doomed, survivor)

      expect(deleteEntityById(doomed)).toBe(true)
      for (const [table, predicate] of [
        ['entities', 'id = ?'],
        ['entity_facts', 'entity_id = ?'],
        ['entity_sessions', 'entity_id = ?'],
        ['entity_edges', 'source_entity_id = ? OR target_entity_id = ?']
      ] as const) {
        const params = table === 'entity_edges' ? [doomed, doomed] : [doomed]
        expect(
          db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get(...params)
        ).toEqual({ count: 0 })
      }
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM entities WHERE id = ?').get(survivor)
      ).toEqual({ count: 1 })
    } finally {
      db.pragma('foreign_keys = ON')
    }
  })

  it('rolls dependent deletion back when deleting the entity fails', () => {
    const db = getDB()
    db.prepare('INSERT INTO conversations (id, app_name) VALUES (?, ?)').run(
      'entity-rollback-session',
      'Notes'
    )
    const doomed = resolve('Rollback Entity', 'Person')
    addEntityFact(doomed, 'This fact must survive rollback', 'entity-rollback-session')
    upsertEntitySession(doomed, 'entity-rollback-session')
    db.exec(`CREATE TRIGGER reject_entity_delete
      BEFORE DELETE ON entities WHEN old.id = ${doomed}
      BEGIN SELECT RAISE(ABORT, 'test delete failure'); END`)

    try {
      expect(() => deleteEntityById(doomed)).toThrow('test delete failure')
      expect(db.prepare('SELECT COUNT(*) AS count FROM entities WHERE id = ?').get(doomed)).toEqual(
        {
          count: 1
        }
      )
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM entity_facts WHERE entity_id = ?').get(doomed)
      ).toEqual({ count: 1 })
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM entity_sessions WHERE entity_id = ?').get(doomed)
      ).toEqual({ count: 1 })
    } finally {
      db.exec('DROP TRIGGER IF EXISTS reject_entity_delete')
    }
  })
})
