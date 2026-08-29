import { createHash } from 'node:crypto'
import type { SemanticDecision } from './browser-playwright-policy'
import type { PlaywrightToolResult } from './playwright-mcp-session'
import type {
  BrowserPlaywrightTaskInput,
  BrowserPlaywrightTaskResult
} from './browser-playwright-task'

export function combinedSignal(parent: AbortSignal | undefined, lease: AbortSignal): AbortSignal {
  return parent ? AbortSignal.any([parent, lease]) : lease
}

export function isStaleReference(result: PlaywrightToolResult): boolean {
  return (
    /ref|element/.test(result.text.toLowerCase()) &&
    /stale|not found|not exist|snapshot|resolve/.test(result.text.toLowerCase())
  )
}

export function isCrashedTarget(result: PlaywrightToolResult): boolean {
  return /target.{0,80}(?:crashed|closed)|page.{0,40}(?:crashed|closed)|browser has been closed|renderer.*crash|session closed/i.test(
    result.text
  )
}

export function hasSemanticReferences(snapshot: string): boolean {
  return /\[ref=[^\]]+\]/.test(snapshot)
}

export function stableActionKey(decision: SemanticDecision): string {
  return JSON.stringify({
    action: decision.action,
    ref: decision.ref,
    text: decision.text,
    key: decision.key,
    values: decision.values,
    startRef: decision.start_ref,
    endRef: decision.end_ref,
    url: decision.url
  })
}

export function fingerprint(snapshot: string): string {
  const stable = snapshot.replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(stable).digest('hex')
}

export function actionLabel(decision: SemanticDecision): string {
  return decision.summary.trim() || decision.reason.trim() || decision.action.replaceAll('_', ' ')
}

export function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240) || 'unknown error'
}

export function fallback(summary: string, handoffs = 0): BrowserPlaywrightTaskResult {
  return { ok: false, fallback: true, summary, handoffs }
}

export async function recoverCrashedTarget(
  input: BrowserPlaywrightTaskInput
): Promise<PlaywrightToolResult> {
  await input.guard.waitUntilRunnable(input.signal)
  input.signal?.throwIfAborted()
  const lease = input.guard.currentActionLease()
  if (!input.guard.canActuate(lease.epoch)) {
    return observeWithCurrentLease(input)
  }
  const current = input.activeUrl()
  const url = /^https?:\/\//i.test(current) ? current : undefined
  input.guard.countStep()
  let recovered: PlaywrightToolResult
  try {
    recovered = await input.session.recoverPage(url, combinedSignal(input.signal, lease.signal))
  } catch (error) {
    if (!lease.signal.aborted) throw error
    return observeWithCurrentLease(input)
  }
  if (!input.guard.ownsActionLease(lease.epoch)) return observeWithCurrentLease(input)
  if (recovered.isError) return recovered
  return observeWithCurrentLease(input)
}

export async function observeWithCurrentLease(
  input: BrowserPlaywrightTaskInput
): Promise<PlaywrightToolResult> {
  for (;;) {
    await input.guard.waitUntilRunnable(input.signal)
    input.signal?.throwIfAborted()
    if (input.guard.isHalted) {
      throw new Error(input.guard.snapshot().reason || 'Task is no longer active')
    }
    const lease = input.guard.currentActionLease()
    let observation: PlaywrightToolResult
    try {
      observation = await input.session.snapshot(combinedSignal(input.signal, lease.signal))
    } catch (error) {
      if (!lease.signal.aborted) throw error
      continue
    }
    if (!input.guard.ownsActionLease(lease.epoch)) continue
    if (input.guard.snapshot().observationRequired && !input.guard.markObservationReady()) continue
    return observation
  }
}
