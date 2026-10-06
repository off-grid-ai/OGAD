// Showing another version of an answer: its versions and which one is shown, merged into the
// context the answer already has (thinking, tool calls, metrics stay). Pure.

export interface AnswerVersions {
  readonly variants: readonly string[]
  readonly variantIndex: number
}

export function withShownVersion(existingJson: string | null, versions: AnswerVersions): string {
  let ctx: Record<string, unknown> = {}
  try {
    const parsed: unknown = existingJson ? JSON.parse(existingJson) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      ctx = parsed as Record<string, unknown>
    }
  } catch {
    // A context that is not JSON keeps nothing but the versions.
  }
  return JSON.stringify({
    ...ctx,
    variants: versions.variants,
    variantIndex: versions.variantIndex
  })
}

/** A version request from the renderer, or null when it is not one. */
export function parseAnswerVersions(raw: unknown): AnswerVersions | null {
  const v = raw as { variants?: unknown; variantIndex?: unknown } | null
  if (!v || !Array.isArray(v.variants) || !v.variants.every((x) => typeof x === 'string')) {
    return null
  }
  const index = v.variantIndex
  return typeof index === 'number' &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < v.variants.length
    ? { variants: v.variants as string[], variantIndex: index }
    : null
}
