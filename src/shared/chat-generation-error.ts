import { explainFailure } from '@offgrid/failures'

/**
 * The words a failed reply keeps. A known reason (no chat model, disk full, ...) becomes the shared plain
 * line, which the message row pairs with its next step; anything else keeps the real reason.
 * The main process rethrows the real reason; Electron wraps it as "Error invoking remote method".
 */
export function generationErrorContent(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const message = raw
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800)
  if (!message) return 'Sorry, something went wrong while generating a response.'
  const known = explainFailure(message)
  return known.code === 'unknown' ? message : known.line
}
