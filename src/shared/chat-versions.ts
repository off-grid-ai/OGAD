/** Complete saved answer. Strings remain valid for chats saved by older builds. */
export interface AnswerVersion {
  content: string
  context?: Record<string, unknown>
  fields?: Record<string, unknown>
}
export type ResponseVersion = string | AnswerVersion

export function versionContent(version: ResponseVersion | undefined, fallback: string): string {
  return typeof version === 'string' ? version : (version?.content ?? fallback)
}

export function readVersions(context: unknown): ResponseVersion[] | undefined {
  if (!context || typeof context !== 'object') return undefined
  const versions = (context as { variants?: unknown }).variants
  return Array.isArray(versions) &&
    versions.length > 1 &&
    versions.every(
      (value) =>
        typeof value === 'string' ||
        (value && typeof value === 'object' && typeof value.content === 'string')
    )
    ? versions
    : undefined
}

export interface StoredVersionRow {
  id: number
  content: string
  context: string | null
}

/** Repair older rows that saved selection only in context. Other readers use content. */
export function selectedVersionRepairs(rows: readonly StoredVersionRow[]): StoredVersionRow[] {
  return rows.flatMap((row) => {
    let context: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(row.context ?? 'null')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
      context = parsed as Record<string, unknown>
    } catch {
      return []
    }
    const variants = readVersions(context)
    const index = context.variantIndex
    if (
      !variants ||
      variants.some((version) => typeof version !== 'string') ||
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0
    )
      return []
    const selected = variants[index]
    const content = versionContent(selected, row.content)
    if (typeof selected !== 'string' || content === row.content) return []
    return [{ ...row, content }]
  })
}
