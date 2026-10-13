/** Build FTS5 syntax from text. Only the caller supplies the join and prefix operators.
 * Quoted words make user-supplied AND/OR/NOT/NEAR ordinary search terms.
 * Empty input returns an empty string: callers must skip MATCH in that case.
 */
export function escapeFtsMatch(
  input: string | readonly string[],
  options: { join?: 'AND' | 'OR' | ' '; prefix?: boolean; maxTokens?: number } = {}
): string {
  const terms =
    typeof input === 'string' ? (input.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}_-]*/gu) ?? []) : input
  return terms
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .slice(0, options.maxTokens ?? 12)
    .map((term) => `"${term.replace(/"/g, '""')}"${options.prefix ? '*' : ''}`)
    .join(options.join === ' ' ? ' ' : ` ${options.join ?? 'OR'} `)
}
