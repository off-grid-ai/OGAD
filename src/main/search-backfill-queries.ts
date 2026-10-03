import { epochMsSql } from './search-ranking'

// Keep the vec_indexed anti-join first in every source predicate. SQLite short-circuits the
// predicate for rows already handled by the backfill, so it does not read their large OCR/text
// values merely to prove that there is no work left.
export const PENDING_SOURCE_SQL = [
  `SELECT 'frame:'||f.id AS key, 'screen' AS kind, f.id AS refId, f.text AS text,
          COALESCE(f.surface,'') AS surface, COALESCE(f.url,'') AS url,
          ${epochMsSql('f.ts')} AS ts
     FROM frames f
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'frame:'||f.id)
      AND f.text IS NOT NULL AND length(f.text) > 20
    LIMIT ?`,
  `SELECT 'obs:'||o.id AS key, 'screen' AS kind, o.id AS refId, o.summary AS text,
          COALESCE(o.surface,'') AS surface, COALESCE(o.url,'') AS url,
          ${epochMsSql('o.ts')} AS ts
     FROM observations o
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'obs:'||o.id)
      AND o.summary IS NOT NULL AND length(o.summary) > 0
    LIMIT ?`,
  `SELECT 'sum:'||s.rowid AS key, 'meeting' AS kind, s.rowid AS refId,
          s.summary AS text, 'Meeting' AS surface, '' AS url, 0 AS ts
     FROM chat_summaries s
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'sum:'||s.rowid)
      AND s.summary IS NOT NULL
    LIMIT ?`,
  `SELECT 'mtg:'||m.id AS key, 'meeting' AS kind, m.id AS refId,
          COALESCE(m.title,'Meeting')||'. '||COALESCE(m.summary, substr(m.transcript,1,2000)) AS text,
          'Meeting' AS surface, '' AS url, COALESCE(m.started_at,0) AS ts
     FROM meetings m
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'mtg:'||m.id)
      AND COALESCE(m.summary, m.transcript) IS NOT NULL
    LIMIT ?`,
  `SELECT 'mem:'||m.id AS key, 'memory' AS kind, m.id AS refId, m.content AS text,
          COALESCE(m.source_app,'') AS surface, '' AS url, 0 AS ts
     FROM memories m
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'mem:'||m.id)
      AND m.content IS NOT NULL
    LIMIT ?`,
  `SELECT 'ent:'||e.id AS key, 'entity' AS kind, e.id AS refId,
          e.name||' '||COALESCE(e.summary,'') AS text, 'Entity' AS surface, '' AS url, 0 AS ts
     FROM entities e
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'ent:'||e.id)
      AND e.hidden = 0
    LIMIT ?`,
  `SELECT 'fact:'||f.id AS key, 'fact' AS kind, f.entity_id AS refId,
          f.fact AS text, 'Fact' AS surface, '' AS url, 0 AS ts
     FROM entity_facts f
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'fact:'||f.id)
    LIMIT ?`
] as const

export const PENDING_COUNT_SQL = `SELECT
  (SELECT COUNT(*) FROM frames f
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'frame:'||f.id)
      AND f.text IS NOT NULL AND length(f.text) > 20) +
  (SELECT COUNT(*) FROM observations o
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'obs:'||o.id)
      AND o.summary IS NOT NULL AND length(o.summary) > 0) +
  (SELECT COUNT(*) FROM chat_summaries s
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'sum:'||s.rowid)
      AND s.summary IS NOT NULL) +
  (SELECT COUNT(*) FROM meetings m
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'mtg:'||m.id)
      AND COALESCE(m.summary, m.transcript) IS NOT NULL) +
  (SELECT COUNT(*) FROM memories m
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'mem:'||m.id)
      AND m.content IS NOT NULL) +
  (SELECT COUNT(*) FROM entities e
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'ent:'||e.id)
      AND e.hidden = 0) +
  (SELECT COUNT(*) FROM entity_facts f
    WHERE NOT EXISTS (SELECT 1 FROM vec_indexed v WHERE v.key = 'fact:'||f.id)) AS c`
