/**
 * The SqlDriver adapter's routing logic, against a structural fake. The
 * real-SQLite behaviour is proven in the dbtest suite; these cover the
 * branch matrix purely: reader vs non-reader statements through run/get/all.
 */
import { describe, expect, it } from 'vitest'
import { makeUseDriver, type DatabaseLike, type StatementLike } from '../use-driver'

function fakeDb(reader: boolean, rows: unknown[] = [{ id: 1 }, { id: 2 }]): {
  db: DatabaseLike
  calls: string[]
} {
  const calls: string[] = []
  const statement: StatementLike = {
    reader,
    run: (...params: unknown[]) => {
      calls.push(`run:${params.length}`)
      return { changes: 7 }
    },
    get: (...params: unknown[]) => {
      calls.push(`get:${params.length}`)
      return rows[0]
    },
    all: (...params: unknown[]) => {
      calls.push(`all:${params.length}`)
      return rows
    }
  }
  return { db: { prepare: () => statement }, calls }
}

describe('makeUseDriver', () => {
  it('run on a non-reader statement reports the write count', async () => {
    const { db, calls } = fakeDb(false)
    const driver = makeUseDriver(db)
    expect(await driver.run('UPDATE x SET y = ?', [1])).toEqual({ changes: 7 })
    expect(calls).toEqual(['run:1'])
  })

  it('run on a reader statement (UPDATE ... RETURNING) counts returned rows as changes', async () => {
    const { db, calls } = fakeDb(true)
    const driver = makeUseDriver(db)
    expect(await driver.run('UPDATE x ... RETURNING *', [])).toEqual({ changes: 2 })
    expect(calls).toEqual(['all:0'])
  })

  it('get on a reader statement returns the row', async () => {
    const { db } = fakeDb(true, [{ n: 42 }])
    const driver = makeUseDriver(db)
    expect(await driver.get('SELECT n FROM x')).toEqual({ n: 42 })
  })

  it('get on a non-reader statement executes it and returns undefined', async () => {
    const { db, calls } = fakeDb(false)
    const driver = makeUseDriver(db)
    expect(await driver.get('DELETE FROM x WHERE id = ?', [9])).toBeUndefined()
    expect(calls).toEqual(['run:1'])
  })

  it('all returns every row with params applied', async () => {
    const { db, calls } = fakeDb(true, [{ a: 1 }, { a: 2 }, { a: 3 }])
    const driver = makeUseDriver(db)
    expect(await driver.all('SELECT * FROM x WHERE a > ?', [0])).toHaveLength(3)
    expect(calls).toEqual(['all:1'])
  })

  it('defaults params to empty across all three methods', async () => {
    const { db, calls } = fakeDb(true)
    const driver = makeUseDriver(db)
    await driver.run('SELECT 1')
    await driver.get('SELECT 1')
    await driver.all('SELECT 1')
    expect(calls).toEqual(['all:0', 'get:0', 'all:0'])
  })
})
