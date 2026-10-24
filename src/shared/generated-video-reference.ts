export interface GeneratedVideoReference {
  id?: string
  path: string
}

export function readGeneratedVideoReference(context: unknown): GeneratedVideoReference | undefined {
  if (!context || typeof context !== 'object') return undefined
  const reference = (context as Record<string, unknown>).videoRef
  if (!reference || typeof reference !== 'object') return undefined
  const record = reference as Record<string, unknown>
  if (typeof record.path !== 'string' || !record.path) return undefined
  return {
    path: record.path,
    ...(typeof record.id === 'string' ? { id: record.id } : {})
  }
}

export function withGeneratedVideoReference(
  context: Record<string, unknown> | undefined,
  reference: GeneratedVideoReference
): Record<string, unknown> {
  return { ...(context ?? {}), videoRef: reference }
}
