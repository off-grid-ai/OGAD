import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import {
  tokenizeQuery,
  ftsMatchExpression,
  isGenerativeRequest,
  clipText,
  safeParseJson,
  isTrivialMessage,
  appNameLikeClause,
  STOPWORDS
} from '../ipc-query-logic'

describe('tokenizeQuery', () => {
  it('lowercases, splits on whitespace, and strips punctuation', () => {
    expect(tokenizeQuery('Hello, World! Foobar')).toEqual(['hello', 'world', 'foobar'])
  })

  it('drops tokens shorter than 3 chars', () => {
    // 'to' (2) and 'go' (2) are dropped; 'now' (3) kept
    expect(tokenizeQuery('go to now')).toEqual(['now'])
  })

  it('drops stopwords', () => {
    // every token here is a stopword → empty
    expect(tokenizeQuery('what do you know about the project', 6)).toEqual(['project'])
    // sanity: the words we dropped really are in STOPWORDS
    expect(STOPWORDS.has('what')).toBe(true)
    expect(STOPWORDS.has('about')).toBe(true)
  })

  it('de-duplicates tokens preserving first-seen order', () => {
    expect(tokenizeQuery('alpha beta alpha gamma beta')).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('caps the result at maxTokens (default 6)', () => {
    const q = 'one2 two3 four5 six7 nine0 tenx elevenq twelvz'
    expect(tokenizeQuery(q).length).toBe(6)
    expect(tokenizeQuery(q, 2).length).toBe(2)
  })

  it('keeps underscores and hyphens inside a token', () => {
    expect(tokenizeQuery('foo_bar baz-qux')).toEqual(['foo_bar', 'baz-qux'])
  })
})

describe('ftsMatchExpression', () => {
  it('quotes each token as a phrase and OR-joins them (any-term recall)', () => {
    expect(ftsMatchExpression('cafe food near')).toBe('"cafe" OR "food" OR "near"')
  })

  it('quotes a hyphenated token instead of leaving it bare in the MATCH', () => {
    // tokenizeQuery keeps the hyphen, so a bare join produced `best-reviewed`, which FTS5 rejects.
    const expr = ftsMatchExpression('best-reviewed places')
    expect(expr).toContain('"best-reviewed"')
    // never a bare hyphenated bareword adjacent to whitespace/operators
    expect(expr).not.toMatch(/(^|\s)best-reviewed(\s|$)/)
  })

  it('falls back to the whole text as one quoted phrase when nothing tokenises', () => {
    // all stopwords / too short → no tokens; the fallback must still be a quoted phrase, not raw text
    expect(ftsMatchExpression('to of a')).toBe('"to of a"')
  })

  it('escapes an embedded double-quote so the phrase literal stays well-formed', () => {
    expect(ftsMatchExpression('say "hey" now')).toBe('"say" OR "hey" OR "now"')
    // a quote that survives into the fallback phrase is doubled per FTS5 escaping
    expect(ftsMatchExpression('a "b')).toBe('"a ""b"')
  })

  // The real regression: run the built expression against a REAL FTS5 table (node:sqlite ships FTS5)
  // and prove SQLite accepts it. Before the fix the bare `best-reviewed` threw `no such column:
  // reviewed`, which failed the entire rag:chat retrieval and surfaced as "something went wrong".
  describe('against a real FTS5 table', () => {
    const withFts = (fn: (db: InstanceType<typeof DatabaseSync>) => void): void => {
      const db = new DatabaseSync(':memory:')
      try {
        db.exec('CREATE VIRTUAL TABLE entity_fts USING fts5(name, summary)')
        db.prepare('INSERT INTO entity_fts(name, summary) VALUES (?, ?)').run(
          'Cafe Roma',
          'best reviewed place near good food'
        )
        fn(db)
      } finally {
        db.close()
      }
    }

    const failingPrompt =
      'Find the three best-reviewed places near me for a specific kind of food, open right now.'

    it('reproduces the original failure with the old bare-join form', () => {
      withFts((db) => {
        const bare = tokenizeQuery(failingPrompt).join(' OR ') // the pre-fix expression
        expect(bare).toContain('best-reviewed')
        expect(() =>
          db.prepare('SELECT name FROM entity_fts WHERE entity_fts MATCH ?').all(bare)
        ).toThrow(/no such column/)
      })
    })

    it('accepts the fixed expression and still matches the row', () => {
      withFts((db) => {
        const expr = ftsMatchExpression(failingPrompt)
        const rows = db
          .prepare('SELECT name FROM entity_fts WHERE entity_fts MATCH ?')
          .all(expr) as { name: string }[]
        expect(rows.map((r) => r.name)).toContain('Cafe Roma')
      })
    })

    it('never throws on hyphenated or punctuation-heavy input', () => {
      withFts((db) => {
        for (const q of ['e-commerce back-end co-founder', 'twenty-first', 'a---b', 'x: y', '"quoted"']) {
          expect(() =>
            db.prepare('SELECT name FROM entity_fts WHERE entity_fts MATCH ?').all(ftsMatchExpression(q))
          ).not.toThrow()
        }
      })
    })
  })
})

describe('isGenerativeRequest', () => {
  it('is true when a build verb and a code/UI noun co-occur', () => {
    expect(isGenerativeRequest('build a react app')).toBe(true)
    expect(isGenerativeRequest('write an svg')).toBe(true)
    expect(isGenerativeRequest('make a landing page')).toBe(true)
    expect(isGenerativeRequest('create a dashboard component')).toBe(true)
  })

  it('is false without a build verb', () => {
    // has the noun "app" but no verb
    expect(isGenerativeRequest('what is a react app')).toBe(false)
  })

  it('is false without a code/UI noun', () => {
    expect(isGenerativeRequest('write a poem about the sea')).toBe(false)
  })

  it('is false for empty / whitespace input', () => {
    expect(isGenerativeRequest('')).toBe(false)
    expect(isGenerativeRequest('   ')).toBe(false)
  })
})

describe('clipText', () => {
  it('returns text unchanged when under the limit', () => {
    expect(clipText('hello', 10)).toBe('hello')
  })

  it('returns text unchanged when exactly at the limit', () => {
    expect(clipText('hello', 5)).toBe('hello')
  })

  it('clips and appends an ellipsis when over the limit', () => {
    // limit 5 → keep 4 chars + ellipsis, length stays 5
    expect(clipText('hello world', 5)).toBe('hell…')
  })

  it('returns empty string for empty/undefined input', () => {
    expect(clipText('', 10)).toBe('')
    expect(clipText(undefined as unknown as string, 10)).toBe('')
  })
})

describe('safeParseJson', () => {
  it('parses valid JSON', () => {
    expect(safeParseJson('{"a":1}', { a: 0 })).toEqual({ a: 1 })
  })

  it('strips ```json fences before parsing', () => {
    expect(safeParseJson('```json\n{"store":true}\n```', { store: false })).toEqual({ store: true })
  })

  it('returns the fallback on invalid JSON', () => {
    const fallback = { store: false }
    expect(safeParseJson('not json at all', fallback)).toBe(fallback)
  })
})

describe('isTrivialMessage', () => {
  it('treats empty / whitespace as trivial', () => {
    expect(isTrivialMessage('')).toBe(true)
    expect(isTrivialMessage('   ')).toBe(true)
  })

  it('treats short pleasantries as trivial (case-insensitive, optional punctuation)', () => {
    expect(isTrivialMessage('hi')).toBe(true)
    expect(isTrivialMessage('OK')).toBe(true)
    expect(isTrivialMessage('Thanks!')).toBe(true)
    expect(isTrivialMessage('thank you.')).toBe(true)
  })

  it('treats a real question as non-trivial', () => {
    expect(isTrivialMessage('what did I work on yesterday?')).toBe(false)
  })

  it('a long message is never trivial even if it starts like a pleasantry', () => {
    expect(isTrivialMessage('hello there, can you help me draft an email')).toBe(false)
  })
})

describe('appNameLikeClause — single source for the optional app-name filter', () => {
  it('returns null for "All" or an empty/absent app (no filter = every app)', () => {
    expect(appNameLikeClause('All', 'source_app')).toBeNull()
    expect(appNameLikeClause('', 'source_app')).toBeNull()
    expect(appNameLikeClause(undefined, 'source_app')).toBeNull()
  })

  it('builds a LIKE clause + wildcarded param for a specific app', () => {
    expect(appNameLikeClause('Slack', 'source_app')).toEqual({
      clause: 'source_app LIKE ?',
      param: '%Slack%'
    })
  })

  it('uses the column the caller passes (the 4 rag:chat sites differ)', () => {
    expect(appNameLikeClause('Gmail', 'memories.source_app')).toEqual({
      clause: 'memories.source_app LIKE ?',
      param: '%Gmail%'
    })
    expect(appNameLikeClause('Gmail', 'c.app_name')).toEqual({
      clause: 'c.app_name LIKE ?',
      param: '%Gmail%'
    })
  })

  it('ipc.ts builds every app-name filter from this helper, not an inline guard', () => {
    // ipc.ts is a coverage-excluded IPC shell; guard the contract by reading source.
    const src = readFileSync(join(__dirname, '../ipc.ts'), 'utf8')
    expect(src).not.toMatch(/appName !== 'All'\)\s*\{[^}]*LIKE \?/s) // no inline appName+LIKE guard
    expect(src).toContain('appNameLikeClause')
  })
})
