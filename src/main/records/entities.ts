// The people and organisations a question names, as one more list for the records engine: the
// question's words are matched against entity names (entity_fts, visible entities only), and the
// best few entities bring their open to-dos and their most recent screen moments. "What did I
// promise Kunal" finds Kunal's open to-dos even when they never say "promise". Names in scripts
// written without spaces (王小明, 田中) are found through entity_fts's trigram twin, and a one- or
// two-character name by its substring among the entities that twin holds.

import {
  ftsQuery,
  ftsTrigramQuery,
  needsTrigram,
  type EntityRecallPort,
  type RecordHit
} from '@offgrid/rag/records'
import { getDB, tableExists } from '../database'
import { actionWhenSql, hydrateRecords, visibleEntity, windowSql } from './sources'

/** Entities a question can bring in. */
const MAX_ENTITIES = 3

type Db = ReturnType<typeof getDB>

/** Visible entities whose name matches `match` in the FTS5 table `fts`, best first. */
function entitiesByName(db: Db, fts: string, match: string): number[] {
  if (!tableExists(db, fts)) return []
  return (
    db
      .prepare(
        `SELECT e.id FROM ${fts} JOIN entities e ON e.id = ${fts}.rowid
          WHERE ${fts} MATCH ? AND ${visibleEntity(db, 'e')}
          ORDER BY bm25(${fts}) LIMIT ?`
      )
      .all(`name : (${match})`, MAX_ENTITIES) as { id: number }[]
  ).map((row) => row.id)
}

/** Visible entities in the trigram twin whose name holds one of `runs` (one or two characters),
 *  most recently updated first. */
function entitiesByShortName(db: Db, runs: string[]): number[] {
  if (!runs.length || !tableExists(db, 'entity_fts_tri')) return []
  return (
    db
      .prepare(
        `SELECT e.id FROM entity_fts_tri_docsize d JOIN entities e ON e.id = d.id
          WHERE (${runs.map(() => 'instr(offgrid_fts_text(e.name), ?) > 0').join(' OR ')})
            AND ${visibleEntity(db, 'e')}
          ORDER BY e.updated_at DESC LIMIT ?`
      )
      .all(...runs, MAX_ENTITIES) as { id: number }[]
  ).map((row) => row.id)
}

export const entityRecall: EntityRecallPort = {
  recall(question, window, limit) {
    const match = ftsQuery(question)
    const trigram = needsTrigram(question) ? ftsTrigramQuery(question) : null
    const db = getDB()
    const found = [
      ...(match ? entitiesByName(db, 'entity_fts', match) : []),
      ...(trigram?.match ? entitiesByName(db, 'entity_fts_tri', trigram.match) : []),
      ...(trigram ? entitiesByShortName(db, trigram.short) : [])
    ]
    const entityIds = [...new Set(found)].slice(0, MAX_ENTITIES)
    if (!entityIds.length) return []
    const ids = JSON.stringify(entityIds)

    // Open to-dos first: what was promised or asked of the person is the usual question.
    const aw = windowSql(actionWhenSql('a'), window, 'ms')
    const actions = tableExists(db, 'action_items')
      ? (
          db
            .prepare(
              `SELECT a.id FROM action_items a
                WHERE a.entity_id IN (SELECT value FROM json_each(?)) AND a.status = 'open'${aw.sql}
                ORDER BY ${actionWhenSql('a')} DESC LIMIT ?`
            )
            .all(ids, ...aw.args, Math.ceil(limit / 3)) as { id: number }[]
        ).map((row) => `act:${row.id}`)
      : []

    const when = "CAST(strftime('%s', o.ts) AS INTEGER)"
    const w = windowSql('o.ts', window, 'datetime')
    const moments = tableExists(db, 'observation_entities')
      ? (
          db
            .prepare(
              `SELECT DISTINCT o.id FROM observation_entities oe
                 JOIN observations o ON o.id = oe.observation_id
                WHERE oe.entity_id IN (SELECT value FROM json_each(?))${w.sql}
                ORDER BY ${when} DESC LIMIT ?`
            )
            .all(ids, ...w.args, Math.max(1, limit - actions.length)) as { id: number }[]
        ).map((row) => `obs:${row.id}`)
      : []

    return hydrateRecords([...actions, ...moments]) as RecordHit[]
  }
}
