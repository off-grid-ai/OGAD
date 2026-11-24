/**
 * Exact-match grading for the answer-quality evals. An answer passes a case's `all` when every
 * group has one alternative in it, matched as a whole token: lowercased, NFC, thousands
 * separators dropped, spaces collapsed, and no letter or digit right before or after it.
 */

export interface Case {
  id: string
  q: string
  all?: string[][]
  judge?: string
  refuse?: boolean
  script?: 'devanagari'
  lang?: string
  gold?: string[]
  tools?: string[]
  args?: Record<string, Record<string, string>>
  memory?: boolean
  doc?: string
  page?: number
}

export const normalise = (text: string): string =>
  text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/(\d)[,\u00a0\u202f](?=\d{2,3}\b)/gu, '$1')
    .replace(/\s+/g, ' ')

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function hasToken(answer: string, alternative: string): boolean {
  const needle = normalise(alternative)
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escape(needle)}(?![\\p{L}\\p{N}\\p{M}])`, 'u').test(
    normalise(answer)
  )
}

/** The groups the answer misses (empty: every group matched). */
export function missingGroups(answer: string, all: string[][] = []): string[][] {
  return all.filter((group) => !group.some((alternative) => hasToken(answer, alternative)))
}

export const devanagariChars = (text: string): number =>
  [...text].filter((ch) => /[\u0900-\u097F]/.test(ch)).length

/** Fill {{today.day}}, {{today.month}}, {{today.weekday}} and {{daysUntil:MM-DD}}. */
export function fillTemplates(
  groups: string[][] | undefined,
  now = new Date()
): string[][] | undefined {
  if (!groups) return groups
  const fill = (value: string): string =>
    value
      .replace('{{today.day}}', String(now.getDate()))
      .replace('{{today.month}}', now.toLocaleDateString('en-GB', { month: 'long' }))
      .replace('{{today.weekday}}', now.toLocaleDateString('en-GB', { weekday: 'long' }))
      .replace(/\{\{daysUntil:(\d\d)-(\d\d)\}\}/, (_m, mm: string, dd: string) => {
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        let target = new Date(now.getFullYear(), Number(mm) - 1, Number(dd))
        if (target < today) target = new Date(now.getFullYear() + 1, Number(mm) - 1, Number(dd))
        return String(Math.round((target.getTime() - today.getTime()) / 86_400_000))
      })
  return groups.map((group) => group.map(fill))
}

/** The [S#] numbers an answer cites, in order, without repeats. */
export const citedNumbers = (answer: string): number[] => [
  ...new Set([...answer.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])))
]

/** Problems with one tool call's arguments against the case file's schema (required + type). */
export function argProblems(
  args: unknown,
  schema: Record<string, string> | undefined,
  patterns: Record<string, string> = {}
): string[] {
  const problems: string[] = []
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return ['arguments are not an object']
  const record = args as Record<string, unknown>
  for (const [field, type] of Object.entries(schema ?? {})) {
    if (!(field in record)) problems.push(`missing ${field}`)
    else if (typeof record[field] !== type) problems.push(`${field} is not a ${type}`)
    else if (type === 'string' && !(record[field] as string).trim())
      problems.push(`${field} is empty`)
  }
  for (const [field, pattern] of Object.entries(patterns)) {
    if (!new RegExp(pattern, 'i').test(String(record[field] ?? '')))
      problems.push(`${field} does not match /${pattern}/`)
  }
  return problems
}
