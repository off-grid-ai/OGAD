import { needsTrigram, normaliseForIndex } from '@offgrid/rag/records'

/** A SQLite connection that can register functions: the app's better-sqlite3 handle, or
 *  node:sqlite's, which a profile is prepared with before the app opens it. */
export interface SqlFunctionHost {
  function(
    name: string,
    options: { deterministic?: boolean; varargs?: boolean },
    fn: (...values: unknown[]) => unknown
  ): unknown
}

/** The SQLite functions the FTS triggers call. Every connection that writes indexed tables needs them. */
export function registerFtsFunctions(database: SqlFunctionHost): void {
  database.function('offgrid_fts_text', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? normaliseForIndex(value) : (value as null)
  )
  // 1 when any argument is text in a script written without spaces (the trigram twins' filter).
  database.function(
    'offgrid_needs_trigram',
    { deterministic: true, varargs: true },
    (...values: unknown[]) =>
      values.some((value) => typeof value === 'string' && needsTrigram(value)) ? 1 : 0
  )
}
