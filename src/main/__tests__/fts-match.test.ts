import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { escapeFtsMatch } from '../fts-match'

describe('escapeFtsMatch', () => {
  it.each([
    ['release?', '"release"'],
    ['say "release"', '"say" OR "release"'],
    ['title:release', '"title" OR "release"'],
    ['(release)', '"release"'],
    ['AND OR NOT NEAR', '"AND" OR "OR" OR "NOT" OR "NEAR"'],
    ['release* ^code', '"release" OR "code"'],
    ['', ''],
    [' \t\n ', ''],
    ['?:()*^"', ''],
    ['café 日本語 नमस्ते', '"café" OR "日本語" OR "नमस्ते"']
  ])('escapes %j', (query, expected) => {
    const match = escapeFtsMatch(query)
    expect(match).toBe(expected)
    if (!match) return
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE VIRTUAL TABLE terms USING fts5(content)')
      db.prepare('INSERT INTO terms(content) VALUES (?)').run('release code café 日本語 नमस्ते AND')
      expect(() => db.prepare('SELECT * FROM terms WHERE terms MATCH ?').all(match)).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('doubles internal quotes in phrase tokens', () => {
    expect(escapeFtsMatch(['a"b'])).toBe('"a""b"')
  })

  it('keeps caller-supplied prefix and all-term search behavior', () => {
    expect(escapeFtsMatch('release code', { prefix: true, join: 'AND', maxTokens: 1 })).toBe(
      '"release"*'
    )
  })
})
