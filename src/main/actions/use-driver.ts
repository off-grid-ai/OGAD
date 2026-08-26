/**
 * The storage adapter between the app's SQLite and the @offgrid/use engine.
 *
 * One DB is the source of truth: the engine's queue/state tables live in the
 * SAME better-sqlite3 database the app already owns (getDB), not a second
 * store that could disagree with it. This module is deliberately pure - it
 * takes any better-sqlite3-shaped handle by structure (the app's
 * better-sqlite3-multiple-ciphers instance and plain better-sqlite3 in tests
 * both satisfy it), imports nothing from Electron, and is fully testable
 * against a temp DB.
 *
 * better-sqlite3 is synchronous; the engine's SqlDriver is async so the same
 * spine runs over mobile's async SQLite later. Wrapping sync in resolved
 * promises costs nothing here.
 */
import type { SqlDriver } from '@offgrid/use'

export interface StatementLike {
  /** true when the statement returns rows (SELECT, or UPDATE ... RETURNING). */
  reader: boolean
  run(...params: unknown[]): { changes: number }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface DatabaseLike {
  prepare(sql: string): StatementLike
}

export function makeUseDriver(db: DatabaseLike): SqlDriver {
  return {
    async run(sql, params = []) {
      const stmt = db.prepare(sql)
      if (stmt.reader) {
        // A returning statement still mutates; report how many rows it touched.
        return { changes: stmt.all(...params).length }
      }
      return { changes: stmt.run(...params).changes }
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql)
      if (stmt.reader) {
        return stmt.get(...params) as T | undefined
      }
      stmt.run(...params)
      return undefined
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...params) as T[]
    }
  }
}
