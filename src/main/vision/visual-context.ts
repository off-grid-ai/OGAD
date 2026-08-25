import { getDB } from '../database'

interface VisualContextRow {
  title: string
  summary: string | null
  steps_json: string
}

function safeSteps(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value)
      ? value.filter((step): step is string => typeof step === 'string').slice(-3)
      : []
  } catch {
    return []
  }
}

/** Retrieve bounded text facts from earlier completed Computer Use runs.
 * Screenshots are never returned. The current frame remains the only image in
 * the model request, so old visual state cannot be mistaken for the live UI. */
export function recentVisualFacts(excludingTaskId: string, limit = 3): string[] {
  const safeLimit = Math.max(0, Math.min(5, Math.floor(limit)))
  if (safeLimit === 0) return []
  try {
    const rows = getDB()
      .prepare(
        `SELECT title, summary, steps_json
           FROM task_run_history
          WHERE kind = 'computer_use'
            AND task_id <> ?
            AND status IN ('done', 'failed', 'stopped')
          ORDER BY updated_at DESC
          LIMIT ?`
      )
      .all(excludingTaskId, safeLimit) as VisualContextRow[]
    return rows.map((row) => {
      const outcome =
        row.summary?.trim() || safeSteps(row.steps_json).join('; ') || 'No outcome saved.'
      return `${row.title}: ${outcome}`
    })
  } catch {
    // A new profile may not have migrated task history yet. Retrieval is an
    // optional enhancement and must never prevent a live Computer Use run.
    return []
  }
}
