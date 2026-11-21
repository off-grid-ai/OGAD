/**
 * Write the synthetic memory profile (shared/eval/profile.json) into a fresh, plaintext profile
 * database that the app has already created (so its tables, FTS indexes and triggers exist).
 *
 * Rows go in the way the real writers put them: capture rows through the shared capture fixtures
 * (the same columns and defaults as Pro's writers), chats as rag_conversations + rag_messages, and
 * every insert through the app's own FTS functions so the keyword triggers fire. The records engine
 * queues the new rows for embedding when the app opens the profile again.
 *
 * Returns each profile item's record key (obs:12, mtg:3, act:2, chat:<id>), for recall@10.
 */
import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import { registerFtsFunctions } from '../../src/main/fts-functions.ts'
import {
  linkObservationFrame,
  writeActionItem,
  writeFrame,
  writeMeeting,
  writeObservation
} from '../../src/main/__tests__/harness/capture-fixtures.ts'

interface Dated {
  id: string
  daysAgo: number
  hour?: number
}
export interface Profile {
  meetings: (Dated & { title: string; summary: string; transcript: string; minutes: number })[]
  notes: (Dated & { text: string })[]
  captures: (Dated & { app: string; surfaceApp: string; url?: string; summary: string })[]
  actions: (Dated & { text: string; entity?: string })[]
}

/** Local time `daysAgo` days back at `hour`, never later than an hour ago (a "today" item). */
export function itemTime(daysAgo: number, hour = 13, now = new Date()): Date {
  const at = new Date(now)
  at.setDate(at.getDate() - daysAgo)
  at.setHours(hour, 0, 0, 0)
  if (at.getTime() > now.getTime() - 3_600_000) {
    const midnight = new Date(now)
    midnight.setHours(0, 1, 0, 0)
    return new Date(Math.max(midnight.getTime(), now.getTime() - 3_600_000))
  }
  return at
}

/** SQLite datetime text, UTC, as CURRENT_TIMESTAMP writes it. */
const sqliteTime = (date: Date): string => date.toISOString().slice(0, 19).replace('T', ' ')

export function seedProfile(
  dbPath: string,
  profile: Profile,
  now = new Date()
): Record<string, string> {
  const db = new DatabaseSync(dbPath)
  registerFtsFunctions(db)
  const keys: Record<string, string> = {}
  db.exec('BEGIN')
  try {
    for (const m of profile.meetings) {
      const start = itemTime(m.daysAgo, m.hour, now)
      const id = writeMeeting(db, {
        title: m.title,
        summary: m.summary,
        transcript: m.transcript,
        startedAt: start.getTime(),
        endedAt: start.getTime() + m.minutes * 60_000,
        durationSec: m.minutes * 60
      })
      keys[m.id] = `mtg:${id}`
    }
    for (const c of profile.captures) {
      const ts = sqliteTime(itemTime(c.daysAgo, c.hour, now))
      const observation = {
        summary: c.summary,
        surface: c.app,
        surfaceApp: c.surfaceApp,
        url: c.url ?? null,
        category: c.app === 'WhatsApp' ? 'communication' : 'work',
        engagement: 0.6,
        salience: 0.7,
        ts
      }
      const id = writeObservation(db, observation)
      const frame = writeFrame(
        db,
        { text: c.summary, windowTitle: c.app, source: 'ax' },
        observation
      )
      linkObservationFrame(db, id, frame)
      keys[c.id] = `obs:${id}`
    }
    for (const a of profile.actions) {
      const at = itemTime(a.daysAgo, 12, now).getTime()
      const id = writeActionItem(db, {
        text: a.text,
        entityName: a.entity ?? null,
        sourceApp: 'Off Grid AI',
        sourceTs: at,
        createdAt: at
      })
      keys[a.id] = `act:${id}`
    }
    const conversation = db.prepare(
      'INSERT INTO rag_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    )
    const message = db.prepare(
      'INSERT INTO rag_messages (conversation_id, role, content, created_at, uuid) VALUES (?, ?, ?, ?, ?)'
    )
    for (const n of profile.notes) {
      const at = sqliteTime(itemTime(n.daysAgo, n.hour ?? 13, now))
      const id = crypto.randomUUID()
      conversation.run(id, n.text.replace(/^Note for later:\s*/, '').slice(0, 60), at, at)
      message.run(id, 'user', n.text, at, crypto.randomUUID())
      message.run(id, 'assistant', 'Noted.', at, crypto.randomUUID())
      keys[n.id] = `chat:${id}`
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
  return keys
}
