/** Chat-owned connector mutations always enter the durable action engine. */
import type { ProposeOutcome, TickOutcome } from '@offgrid/use'

export interface ChatConnectorActionsPort {
  propose(input: unknown, meta: { source: 'chat'; sourceRef?: string }): Promise<ProposeOutcome>
  waitForOutcome(actionId: string, timeoutMs: number): Promise<TickOutcome | undefined>
  onParked(actionId: string, listener: () => void): () => void
  kick(): void
}

export type ChatConnectorExecution =
  | { kind: 'unavailable' }
  | { kind: 'refused'; reason: string }
  | { kind: 'deduped'; actionId: string }
  | { kind: 'parked'; actionId: string }
  | { kind: 'running'; actionId: string }
  | { kind: 'finished'; actionId: string; outcome: TickOutcome }

const OUTCOME_WAIT_MS = 30_000

export async function runChatConnectorAction(
  actions: ChatConnectorActionsPort | undefined,
  request: {
    connectorId: number
    tool: string
    connector: string
    args: Record<string, unknown>
    sourceRef?: string
  }
): Promise<ChatConnectorExecution> {
  if (!actions) return { kind: 'unavailable' }
  const proposed = await actions.propose(
    {
      type: 'connector',
      intent: `${request.tool} via ${request.connector}`,
      args: { connectorId: request.connectorId, tool: request.tool, args: request.args },
      risk: 'mutate'
    },
    { source: 'chat', ...(request.sourceRef ? { sourceRef: request.sourceRef } : {}) }
  )
  if (!proposed.accepted) return { kind: 'refused', reason: proposed.reason }
  if (proposed.deduped) return { kind: 'deduped', actionId: proposed.id }

  // Subscribe before starting the drain. A very fast connector can finish in
  // the same turn; registering after kick would miss that terminal outcome.
  const outcomePromise = actions.waitForOutcome(proposed.id, OUTCOME_WAIT_MS)
  let reportParked: (() => void) | undefined
  const parkedPromise = new Promise<void>((resolve) => {
    reportParked = resolve
  })
  const unsubscribeParked = actions.onParked(proposed.id, () => reportParked?.())
  actions.kick()
  const raced = await Promise.race([
    outcomePromise.then((outcome) => ({ kind: 'outcome' as const, outcome })),
    parkedPromise.then(() => ({ kind: 'parked' as const }))
  ]).finally(unsubscribeParked)
  if (raced.kind === 'parked') return { kind: 'parked', actionId: proposed.id }
  if (!raced.outcome) return { kind: 'running', actionId: proposed.id }
  return { kind: 'finished', actionId: proposed.id, outcome: raced.outcome }
}
