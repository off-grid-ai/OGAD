import { describe, expect, it } from 'vitest'
import { runChatConnectorAction, type ChatConnectorActionsPort } from '../chat-connector-action'
import type { ProposeOutcome, TickOutcome } from '@offgrid/use'

const request = { connectorId: 4, tool: 'create_issue', connector: 'GitHub', args: { title: 'x' }, sourceRef: 'msg-1' }

function port(over: Partial<ChatConnectorActionsPort> & { proposed?: ProposeOutcome; outcome?: TickOutcome | undefined; parkBeforeOutcome?: boolean } = {}): ChatConnectorActionsPort & { proposals: unknown[]; kicked: number } {
  const state = { proposals: [] as unknown[], kicked: 0 }
  let parkedListener: (() => void) | undefined
  return {
    proposals: state.proposals,
    get kicked() {
      return state.kicked
    },
    async propose(input, meta) {
      state.proposals.push({ input, meta })
      return over.proposed ?? ({ accepted: true, id: 'act-1', deduped: false } as ProposeOutcome)
    },
    async waitForOutcome() {
      if (over.parkBeforeOutcome) {
        // The engine parks the action after the drain starts; the listener is registered by then.
        setTimeout(() => parkedListener?.(), 0)
        return new Promise(() => {})
      }
      return over.outcome
    },
    onParked(_id, listener) {
      parkedListener = listener
      return () => {
        parkedListener = undefined
      }
    },
    kick() {
      state.kicked++
    },
    ...over
  }
}

describe('chat connector actions enter the durable engine', () => {
  it('is unavailable without an engine', async () => {
    expect(await runChatConnectorAction(undefined, request)).toEqual({ kind: 'unavailable' })
  })

  it('proposes a mutate-risk connector action from the chat with its source reference', async () => {
    const actions = port({ outcome: { status: 'done' } as unknown as TickOutcome })
    const result = await runChatConnectorAction(actions, request)
    expect(actions.proposals[0]).toEqual({
      input: {
        type: 'connector',
        intent: 'create_issue via GitHub',
        args: { connectorId: 4, tool: 'create_issue', args: { title: 'x' } },
        risk: 'mutate'
      },
      meta: { source: 'chat', sourceRef: 'msg-1' }
    })
    expect(actions.kicked).toBe(1)
    expect(result).toEqual({ kind: 'finished', actionId: 'act-1', outcome: { status: 'done' } })
  })

  it('reports a refusal and a dedupe without draining', async () => {
    const refused = port({ proposed: { accepted: false, reason: 'blocked by policy' } as ProposeOutcome })
    expect(await runChatConnectorAction(refused, request)).toEqual({ kind: 'refused', reason: 'blocked by policy' })
    expect(refused.kicked).toBe(0)
    const deduped = port({ proposed: { accepted: true, id: 'act-9', deduped: true } as ProposeOutcome })
    expect(await runChatConnectorAction(deduped, request)).toEqual({ kind: 'deduped', actionId: 'act-9' })
  })

  it('reports parked when the action waits for approval, and running when no outcome lands in time', async () => {
    expect(await runChatConnectorAction(port({ parkBeforeOutcome: true }), request)).toEqual({ kind: 'parked', actionId: 'act-1' })
    expect(await runChatConnectorAction(port({ outcome: undefined }), { ...request, sourceRef: undefined })).toEqual({
      kind: 'running',
      actionId: 'act-1'
    })
  })
})
