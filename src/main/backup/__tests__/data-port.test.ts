import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3-multiple-ciphers'
import { DesktopBackupDataPort } from '../data-port'
import type { DesktopBackupData } from '../types'

/**
 * What a backup takes out of the database, and what restoring one puts back.
 *
 * Run against a REAL SQLite engine (node:sqlite) using the app's own DDL, because every interesting
 * question here is a question about SQL: which rows a project-scoped export includes, whether a restore
 * skips a project that already exists, whether a document is recognised as already-present, what happens
 * to a conversation whose project is absent. A hand-written fake matcher would answer those from its
 * author's beliefs about the queries rather than from the queries.
 *
 * The app ships better-sqlite3-multiple-ciphers, which needs a native build for the runner's ABI; the one
 * API this port uses beyond prepare() is transaction(), so that is supplied over the real engine below.
 * Everything the port does - the SQL, the row mapping, the JSON handling, the ordering - is real.
 */

/** The schema these queries run against, copied from the app's own migrations. */
const SCHEMA = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    icon TEXT,
    include_memory INTEGER NOT NULL DEFAULT 1,
    origin_device_id TEXT,
    origin_device_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE rag_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_id TEXT,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'text',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE rag_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    position INTEGER NOT NULL,
    embedding TEXT
  );
  CREATE TABLE rag_conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    project_id TEXT,
    origin_device_id TEXT,
    origin_device_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE rag_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    uuid TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    context TEXT,
    origin_device_id TEXT,
    origin_device_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`

/**
 * A real SQLite database presented the way the port expects one.
 *
 * node:sqlite IS SQLite - the queries, the types and the ordering are genuine. It has no transaction()
 * helper, so that one method is provided here with the semantics better-sqlite3 documents: run the body
 * inside BEGIN, COMMIT on return, ROLLBACK if it throws. That matters for the assertions about a failed
 * restore leaving nothing behind, which would pass vacuously against a fake that ignored transactions.
 */
function realDatabase(): Database.Database {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  const transaction =
    (body: (...args: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      db.exec('BEGIN')
      try {
        const result = body(...args)
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  // Assigned through a record cast: better-sqlite3's transaction() is a generic overload set that a plain
  // function cannot satisfy structurally, and the port only ever calls it the one way implemented above.
  ;(db as unknown as Record<string, unknown>).transaction = transaction
  return db as unknown as Database.Database
}

// The port announces every restored row so pro sync can pick it up. Asserting on the announcements is how
// a test can tell that a restore joined the mesh rather than quietly writing rows only this device knows.
const mutations: { entity: string; kind: string }[] = []
vi.mock('../../sync-mutation', async () => {
  const actual = await vi.importActual<typeof import('../../sync-mutation')>('../../sync-mutation')
  return {
    ...actual,
    emitSyncMutation: (mutation: { entity: string; kind: string }) => {
      mutations.push({ entity: mutation.entity, kind: mutation.kind })
    }
  }
})

describe('taking a backup out of the database, and putting one back', () => {
  let db: Database.Database
  let port: DesktopBackupDataPort

  beforeEach(() => {
    mutations.length = 0
    db = realDatabase()
    port = new DesktopBackupDataPort(db)
  })

  const insertProject = (id: string, name = id, updatedAt = '2026-01-01 09:00:00'): void => {
    db.prepare(
      `INSERT INTO projects (id, name, description, system_prompt, icon, include_memory, created_at, updated_at)
       VALUES (?, ?, 'desc', 'prompt', 'icon.png', 1, '2026-01-01 09:00:00', ?)`
    ).run(id, name, updatedAt)
  }

  const insertDocument = (projectId: string, name: string): number => {
    const info = db
      .prepare(
        `INSERT INTO rag_documents (sync_id, project_id, name, path, size, kind, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, 'pdf', 1, '2026-01-01 09:00:00')`
      )
      .run(`sync-${name}`, projectId, name, `/docs/${name}`, 42)
    return Number(info.lastInsertRowid)
  }

  const insertChunk = (docId: number, content: string, position: number): void => {
    db.prepare('INSERT INTO rag_chunks (doc_id, content, position) VALUES (?, ?, ?)').run(
      docId,
      content,
      position
    )
  }

  const insertConversation = (
    id: string,
    projectId: string | null,
    title: string | null = 'A chat'
  ): void => {
    db.prepare(
      `INSERT INTO rag_conversations (id, title, project_id, created_at, updated_at)
       VALUES (?, ?, ?, '2026-01-01 09:00:00', '2026-01-01 09:00:00')`
    ).run(id, title, projectId)
  }

  const insertMessage = (
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    context: string | null = null
  ): void => {
    db.prepare(
      `INSERT INTO rag_messages (conversation_id, role, content, context, created_at)
       VALUES (?, ?, ?, ?, '2026-01-01 09:00:00')`
    ).run(conversationId, role, content, context)
  }

  describe('exporting everything', () => {
    it('carries every project with its documents and chunks, and every conversation with its messages', async () => {
      insertProject('p1')
      const docId = insertDocument('p1', 'Contract.pdf')
      insertChunk(docId, 'second half', 1)
      insertChunk(docId, 'first half', 0)
      insertConversation('c1', 'p1')
      insertMessage('c1', 'user', 'what does it say?')
      insertMessage('c1', 'assistant', 'it says hello')

      const data = await port.collectAll()

      expect(data.surface).toBe('offgrid-desktop')
      expect(data.projects).toHaveLength(1)
      expect(data.projects[0]).toMatchObject({
        id: 'p1',
        name: 'p1',
        description: 'desc',
        systemPrompt: 'prompt',
        icon: 'icon.png',
        includeMemory: true
      })
      expect(data.projects[0]!.documents[0]).toMatchObject({
        name: 'Contract.pdf',
        path: '/docs/Contract.pdf',
        size: 42,
        kind: 'pdf',
        enabled: true
      })
      // Chunks in position order, not insertion order: a document reassembled out of order is a document
      // whose text is scrambled, and the rows can come back in any order without an ORDER BY.
      expect(data.projects[0]!.documents[0]!.chunks).toEqual([
        { content: 'first half', position: 0 },
        { content: 'second half', position: 1 }
      ])
      expect(data.conversations[0]!.messages.map(({ role, content }) => [role, content])).toEqual([
        ['user', 'what does it say?'],
        ['assistant', 'it says hello']
      ])
    })

    it('exports an empty database as an empty backup rather than failing', async () => {
      const data = await port.collectAll()

      expect(data).toEqual({ surface: 'offgrid-desktop', projects: [], conversations: [] })
    })

    it('parses a message context back into an object, and drops one that is not JSON', async () => {
      insertConversation('c1', null)
      insertMessage('c1', 'assistant', 'with context', JSON.stringify({ unified: [], image: 'a.png' }))
      insertMessage('c1', 'assistant', 'corrupt context', '{ truncated')
      insertMessage('c1', 'assistant', 'no context', null)

      const [conversation] = (await port.collectAll()).conversations

      expect(conversation!.messages[0]!.context).toEqual({ unified: [], image: 'a.png' })
      // A corrupt blob must not fail the whole export - the message text is still worth keeping, and
      // context is an enrichment.
      expect(conversation!.messages[1]!.context).toBeUndefined()
      expect(conversation!.messages[2]!.context).toBeUndefined()
    })

    it('lists projects most-recently-updated first', async () => {
      insertProject('older', 'older', '2026-01-01 09:00:00')
      insertProject('newer', 'newer', '2026-02-01 09:00:00')

      expect((await port.collectAll()).projects.map(({ id }) => id)).toEqual(['newer', 'older'])
    })
  })

  describe('exporting one project', () => {
    it('takes the project, its documents, and only the conversations that belong to it', async () => {
      insertProject('p1')
      insertProject('p2')
      insertDocument('p1', 'A.pdf')
      insertDocument('p2', 'B.pdf')
      insertConversation('c1', 'p1')
      insertConversation('c2', 'p2')
      insertConversation('c3', null)

      const data = await port.collectProject('p1')

      // Sharing one project must not hand over another project's chats, nor the unfiled ones - that is a
      // privacy boundary, not a filter for tidiness.
      expect(data!.projects.map(({ id }) => id)).toEqual(['p1'])
      expect(data!.projects[0]!.documents.map(({ name }) => name)).toEqual(['A.pdf'])
      expect(data!.conversations.map(({ id }) => id)).toEqual(['c1'])
    })

    it('answers null for a project that does not exist', async () => {
      await expect(port.collectProject('missing')).resolves.toBeNull()
    })
  })

  describe('exporting one conversation', () => {
    it('takes the conversation and the project it belongs to, without that project-s documents', async () => {
      insertProject('p1')
      insertDocument('p1', 'A.pdf')
      insertConversation('c1', 'p1')
      insertMessage('c1', 'user', 'hello')

      const data = await port.collectConversation('c1')

      // The project travels so the chat lands in the right place, but its documents are a much bigger
      // payload and are not what was asked for.
      expect(data!.conversations.map(({ id }) => id)).toEqual(['c1'])
      expect(data!.projects.map(({ id }) => id)).toEqual(['p1'])
      expect(data!.projects[0]!.documents).toEqual([])
    })

    it('takes an unfiled conversation with no project at all', async () => {
      insertConversation('c1', null)
      insertMessage('c1', 'user', 'hello')

      const data = await port.collectConversation('c1')

      expect(data!.projects).toEqual([])
      expect(data!.conversations[0]!.projectId).toBeNull()
    })

    it('answers null for a conversation that does not exist', async () => {
      await expect(port.collectConversation('missing')).resolves.toBeNull()
    })
  })

  describe('restoring a backup', () => {
    const bundle = (overrides: Partial<DesktopBackupData> = {}): DesktopBackupData => ({
      surface: 'offgrid-desktop',
      projects: [
        {
          id: 'p1',
          name: 'Restored Project',
          description: 'from a backup',
          systemPrompt: 'be helpful',
          icon: 'icon.png',
          includeMemory: true,
          createdAt: '2026-01-01T09:00:00.000Z',
          updatedAt: '2026-01-02T09:00:00.000Z',
          documents: [
            {
              name: 'Contract.pdf',
              path: '/restored/Contract.pdf',
              size: 42,
              kind: 'pdf',
              enabled: true,
              createdAt: '2026-01-01T09:00:00.000Z',
              chunks: [{ content: 'the text', position: 0 }]
            }
          ]
        }
      ],
      conversations: [
        {
          id: 'c1',
          title: 'Restored chat',
          projectId: 'p1',
          createdAt: '2026-01-01T09:00:00.000Z',
          updatedAt: '2026-01-01T09:00:00.000Z',
          messages: [
            { role: 'user', content: 'hello', createdAt: '2026-01-01T09:00:00.000Z' },
            {
              role: 'assistant',
              content: 'hi',
              context: { unified: [] },
              createdAt: '2026-01-01T09:00:01.000Z'
            }
          ]
        }
      ],
      ...overrides
    })

    it('writes the projects, documents, chunks, conversations and messages, and says what it did', async () => {
      const summary = await port.apply(bundle())

      expect(summary).toEqual({
        projectsAdded: 1,
        documentsAdded: 1,
        conversationsAdded: 1,
        messagesAdded: 2
      })
      expect(db.prepare('SELECT name FROM projects WHERE id = ?').get('p1')).toMatchObject({
        name: 'Restored Project'
      })
      expect(db.prepare('SELECT content FROM rag_chunks').all()).toEqual([{ content: 'the text' }])
      expect(
        db.prepare('SELECT role, content FROM rag_messages ORDER BY id').all()
      ).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' }
      ])
    })

    it('announces every restored row, so a restore reaches the other devices too', async () => {
      await port.apply(bundle())

      // Without these, a restored library would exist on this Mac alone and would look like deletions to
      // a paired device that never heard about the rows.
      expect(mutations.length).toBeGreaterThan(0)
      expect(new Set(mutations.map(({ kind }) => kind))).toEqual(new Set(['put']))
    })

    it('leaves a project that already exists alone rather than overwriting the user-s copy', async () => {
      insertProject('p1', 'The name the user chose')

      const summary = await port.apply(bundle())

      // Restoring is additive. Overwriting would let an old backup silently revert a project the user has
      // since renamed and edited.
      expect(db.prepare('SELECT name FROM projects WHERE id = ?').get('p1')).toMatchObject({
        name: 'The name the user chose'
      })
      expect(summary.projectsAdded).toBe(0)
    })

    it('fills in messages the archive has for a conversation that already exists', async () => {
      // Synced from another device, or half-restored by an earlier run: the conversation is here, one of its
      // messages is not.
      db.prepare(
        `INSERT INTO rag_conversations (id, title, project_id, created_at, updated_at)
         VALUES ('c1', 'Existing', NULL, '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO rag_messages (uuid, conversation_id, role, content, context, created_at)
         VALUES ('m-existing', 'c1', 'user', 'first question', NULL, '2026-01-01T09:00:00.000Z')`
      ).run()

      await port.apply(
        bundle({
          conversations: [
            {
              id: 'c1',
              title: 'Existing',
              projectId: null,
              createdAt: '2026-01-01T09:00:00.000Z',
              updatedAt: '2026-01-02T09:00:00.000Z',
              messages: [
                { role: 'user', content: 'first question', createdAt: '2026-01-01T09:00:00.000Z' },
                { role: 'assistant', content: 'the missing answer', createdAt: '2026-01-01T09:01:00.000Z' }
              ]
            }
          ]
        })
      )

      const contents = (
        db
          .prepare('SELECT content FROM rag_messages WHERE conversation_id = ? ORDER BY created_at ASC')
          .all('c1') as Array<{ content: string }>
      ).map(({ content }) => content)

      // The archived message that was missing is now here, and the one already present is not duplicated. The
      // old code skipped the whole conversation, so an additive restore reported success and silently left the
      // history incomplete.
      expect(contents).toEqual(['first question', 'the missing answer'])
    })

    it('embeds restored chunks, so a restored document can actually answer', async () => {
      // A deterministic stand-in for MiniLM: the real one is a model file, and what matters here is that the
      // vector REACHES the row - retrieval requires a non-null embedding
      // ("WHERE d.enabled = 1 AND c.embedding IS NOT NULL" in rag/store.ts).
      const embedding = [0.1, 0.2, 0.3]
      const embedded = new DesktopBackupDataPort(db, async () => embedding)

      await embedded.apply(bundle())

      const chunk = db
        .prepare(
          `SELECT c.embedding AS embedding FROM rag_chunks c
             JOIN rag_documents d ON d.id = c.doc_id
            WHERE d.path = ?`
        )
        .get('/restored/Contract.pdf') as { embedding: string | null } | undefined
      // Restored chunks used to land NULL and nothing ever re-embedded them - the background backfill covers
      // observations, frames and transcripts, never rag_chunks - so the document sat in its project looking
      // enabled and could never inform an answer.
      expect(chunk?.embedding).toBe(JSON.stringify(embedding))
    })

    it('still restores the document when no embedder is available', async () => {
      const noModel = new DesktopBackupDataPort(db, async () => {
        throw new Error('the embedding model is not loaded')
      })

      const summary = await noModel.apply(bundle())

      // A model that cannot load is not a reason to lose the restore. The document lands exactly as it did
      // before embedding-on-restore existed, which is worse than being searchable and far better than failing.
      expect(summary.documentsAdded).toBe(1)
      const chunk = db
        .prepare(
          `SELECT c.embedding AS embedding FROM rag_chunks c
             JOIN rag_documents d ON d.id = c.doc_id
            WHERE d.path = ?`
        )
        .get('/restored/Contract.pdf') as { embedding: string | null } | undefined
      expect(chunk?.embedding).toBeNull()
    })

    it('does not add a document it already holds', async () => {
      insertProject('p1', 'Existing')
      const existing = insertDocument('p1', 'Contract.pdf')
      insertChunk(existing, 'the text', 0)
      const before = db.prepare('SELECT COUNT(*) AS n FROM rag_documents').get() as { n: number }

      const summary = await port.apply(
        bundle({
          projects: [
            {
              ...bundle().projects[0]!,
              documents: [
                {
                  ...bundle().projects[0]!.documents[0]!,
                  name: 'Contract.pdf',
                  path: '/docs/Contract.pdf'
                }
              ]
            }
          ]
        })
      )

      // Restoring the same backup twice is a thing people do. Each repeat adding another copy of every
      // document would grow the library without bound and show duplicates in the UI.
      const after = db.prepare('SELECT COUNT(*) AS n FROM rag_documents').get() as { n: number }
      expect(after.n).toBe(before.n)
      expect(summary.documentsAdded).toBe(0)
    })

    it('is idempotent: applying the same backup twice changes nothing the second time', async () => {
      await port.apply(bundle())
      const first = db.prepare('SELECT COUNT(*) AS n FROM rag_messages').get() as { n: number }

      const summary = await port.apply(bundle())

      const second = db.prepare('SELECT COUNT(*) AS n FROM rag_messages').get() as { n: number }
      expect(second.n).toBe(first.n)
      expect(summary).toMatchObject({
        projectsAdded: 0,
        conversationsAdded: 0,
        messagesAdded: 0
      })
    })

    it('keeps a conversation whose project is missing, rather than dropping the chat', async () => {
      const summary = await port.apply(
        bundle({
          projects: [],
          conversations: [{ ...bundle().conversations[0]!, projectId: 'a-project-not-in-this-backup' }]
        })
      )

      // The messages are the irreplaceable part. Filing the chat under a project that is not there would
      // hide it; discarding it would lose it. It comes back unfiled.
      expect(summary.conversationsAdded).toBe(1)
      expect(db.prepare('SELECT project_id FROM rag_conversations WHERE id = ?').get('c1')).toEqual({
        project_id: null
      })
    })

    it('stores a message context as JSON, and nothing when there is none', async () => {
      await port.apply(bundle())

      const rows = db.prepare('SELECT context FROM rag_messages ORDER BY id').all() as {
        context: string | null
      }[]
      expect(rows[0]!.context).toBeNull()
      expect(JSON.parse(rows[1]!.context!)).toEqual({ unified: [] })
    })

    it('restores an empty backup as a no-op', async () => {
      const summary = await port.apply({
        surface: 'offgrid-desktop',
        projects: [],
        conversations: []
      })

      expect(summary).toEqual({
        projectsAdded: 0,
        documentsAdded: 0,
        conversationsAdded: 0,
        messagesAdded: 0
      })
    })

    it('survives the full round trip: export, restore into an empty database, export again', async () => {
      insertProject('p1')
      const docId = insertDocument('p1', 'Contract.pdf')
      insertChunk(docId, 'the text', 0)
      insertConversation('c1', 'p1')
      insertMessage('c1', 'user', 'hello')
      const exported = await port.collectAll()

      const restoredDb = realDatabase()
      await new DesktopBackupDataPort(restoredDb).apply(exported)
      const reExported = await new DesktopBackupDataPort(restoredDb).collectAll()

      // The strongest statement available: what came out went back in and came out the same. Timestamps
      // are the app's own strings, so they survive verbatim too.
      expect(reExported).toEqual(exported)
    })
  })
})
