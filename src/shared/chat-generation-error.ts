/** The main process rethrows the real reason; Electron wraps it as "Error invoking remote method". */
export function generationErrorContent(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const message = raw
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800)
  return message || 'Sorry, something went wrong while generating a response.'
}
