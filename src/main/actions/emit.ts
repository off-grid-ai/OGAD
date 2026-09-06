/**
 * Emission hardening (R1 box 12) - how a weak local model reliably produces
 * a valid ActionProposal.
 *
 * Three layers, per the porting research:
 * 1. Constrain: actionProposalJsonSchema() goes to llama-server as
 *    grammar-constrained response_format, so a conforming decode CANNOT be
 *    shaped wrong. (The schema is not injected into the prompt - the prompt
 *    builder must still describe the action types.)
 * 2. Coerce (SAP, ported idea from BAML's schema-aligned parsing): when raw
 *    output arrives anyway - fenced, wrapped in prose, trailing commas,
 *    unquoted keys - deterministic repairs produce candidates and the first
 *    one that passes the fail-closed schema wins. Repairs only ever ADD a
 *    candidate; they never mutate the original, so a bad repair cannot turn
 *    a valid emission into a different one.
 * 3. Retry (Instructor pattern): emitActionProposal asks again with the
 *    validation error fed back, bounded. An unrepairable emission is
 *    rejected, never guessed.
 *
 * Pure module: no Electron, the asker is injected.
 */
import { parseActionProposal, RISK_CLASSES, type ActionProposal, type ActionType } from '@offgrid/use'

/**
 * The wire schema for llama-server's response_format. `type` is constrained
 * to the HANDLERS ACTUALLY REGISTERED, not the full vocabulary - the model
 * cannot propose an action this build cannot execute.
 */
export function actionProposalJsonSchema(types: readonly ActionType[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...types] },
      intent: { type: 'string', minLength: 1 },
      args: { type: 'object', additionalProperties: true },
      risk: { type: 'string', enum: [...RISK_CLASSES] },
      triggerAt: { type: 'integer', minimum: 1 }
    },
    required: ['type', 'intent', 'args', 'risk'],
    additionalProperties: false
  }
}

/** The first balanced {...} in the text, respecting strings and escapes. */
export function extractBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start === -1) {
    return undefined
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }
  return undefined
}

const stripFences = (text: string): string =>
  text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '')

const dropTrailingCommas = (text: string): string => text.replace(/,(\s*[}\]])/g, '$1')

/** Quote bare object keys - a heuristic repair, only ever an extra candidate. */
const quoteBareKeys = (text: string): string =>
  text.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')

/**
 * Repair candidates in trust order: the raw text first, then progressively
 * repaired variants. Deduped; each is tried against the fail-closed schema.
 */
export function extractCandidates(raw: string): string[] {
  const candidates: string[] = [raw.trim()]
  const unfenced = stripFences(raw).trim()
  candidates.push(unfenced)
  const balanced = extractBalancedObject(unfenced)
  if (balanced) {
    candidates.push(balanced)
    candidates.push(dropTrailingCommas(balanced))
    candidates.push(quoteBareKeys(dropTrailingCommas(balanced)))
  }
  return [...new Set(candidates)].filter((c) => c.length > 0)
}

export type EmissionResult =
  | { ok: true; proposal: ActionProposal }
  | { ok: false; error: string }

/** Parse one raw emission through the repair ladder. Fail closed. */
export function parseEmission(raw: string): EmissionResult {
  let lastError = 'no JSON object found in the output'
  for (const candidate of extractCandidates(raw)) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    const parsed = parseActionProposal(value)
    if (parsed.ok) {
      return { ok: true, proposal: parsed.value }
    }
    lastError = parsed.error
  }
  return { ok: false, error: lastError }
}

/**
 * Ask, parse, and on failure ask again with the error fed back - bounded.
 * The asker owns the model call (and the response_format constraint); this
 * owns the loop and the discipline that exhaustion means rejection.
 */
export async function emitActionProposal(
  ask: (feedback?: string) => Promise<string>,
  options: { maxAttempts?: number } = {}
): Promise<EmissionResult> {
  const maxAttempts = options.maxAttempts ?? 2
  let feedback: string | undefined
  let last: EmissionResult = { ok: false, error: 'no attempts were made' }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const raw = await ask(feedback)
    last = parseEmission(raw)
    if (last.ok) {
      return last
    }
    feedback = `The last output was not a valid action: ${last.error}. Reply with ONLY the corrected JSON object, nothing else.`
  }
  return last
}
