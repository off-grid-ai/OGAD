import { explainFailure, type FailureCode } from '@offgrid/failures'

const MISSING_MODEL = new Set<FailureCode>(['no-text-model', 'no-image-model', 'no-video-model'])

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
  // Only a missing model is swapped for its plain line; anything else (an engine that is down) keeps
  // the real reason, which names what failed.
  const known = explainFailure(message)
  return MISSING_MODEL.has(known.code) ? known.line : message
}
