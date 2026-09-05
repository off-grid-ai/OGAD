// @vitest-environment jsdom
/** The preload boundary is the only fake; the product component consumes Shared's UseSnapshot. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ActionRecord, UseSnapshot } from '@offgrid/application'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionGateDock } from '../ActionGateDock'

const EMPTY_PROJECTION: UseSnapshot = {
  actions: [],
  active: [],
  terminal: [],
  recoverable: [],
  running: false
}

const actionRecord = (overrides: Partial<ActionRecord> = {}): ActionRecord => ({
  id: 'act_1',
  type: 'message',
  intent: 'Send a message to Ali',
  args: { to: 'ali@x.test', text: 'the deck is ready' },
  risk: 'irreversible',
  source: 'chat',
  payloadHash: 'a'.repeat(64),
  idempotencyKey: 'message:ali:deck',
  attempts: 0,
  attemptLog: [],
  state: 'awaiting_approval',
  createdAt: 1,
  updatedAt: 1,
  sourceRef: 'chat-1',
  ...overrides
})

const projectionWithActive = (record: ActionRecord): UseSnapshot => ({
  ...EMPTY_PROJECTION,
  actions: [record],
  active: [record]
})

const projectionWithRecovery = (record: ActionRecord): UseSnapshot => {
  const failedRecord = actionRecord({
    ...record,
    state: 'needs_help',
    attempts: 1,
    attemptLog: [
      {
        rail: 'semantic',
        at: 2,
        outcome: 'error',
        detail: 'The destination rejected the change.'
      }
    ],
    updatedAt: 2
  })
  const recovery: UseSnapshot['recoverable'][number] = {
    actionId: failedRecord.id,
    outcome: 'needs_help',
    record: failedRecord,
    completedAt: 2,
    undoneAt: null,
    availableIntents: ['retry']
  }
  return { ...EMPTY_PROJECTION, terminal: [recovery], recoverable: [recovery] }
}

let projection: UseSnapshot
let projectionListener: ((snapshot: UseSnapshot) => void) | undefined
const offProjection = vi.fn()
const resolveGate = vi.fn(async () => true)
const retry = vi.fn(async () => ({ ok: true, value: true }))

const emitProjection = (next: UseSnapshot): void => {
  projection = next
  act(() => projectionListener?.(next))
}

beforeEach(() => {
  projection = EMPTY_PROJECTION
  projectionListener = undefined
  offProjection.mockClear()
  resolveGate.mockClear()
  retry.mockClear()
  window.api = {
    actions: {
      getProjection: async () => projection,
      onProjection: (listener: (snapshot: UseSnapshot) => void) => {
        projectionListener = listener
        return offProjection
      },
      retry,
      resolveGate
    }
  } as never
})

afterEach(cleanup)

describe('<ActionGateDock/>', () => {
  it('renders nothing when the shared projection has no action needing attention', () => {
    const { container } = render(<ActionGateDock conversationId="chat-1" />)
    expect(container.firstChild).toBeNull()
  })

  it('hydrates an existing pending gate from the initial shared projection', async () => {
    projection = projectionWithActive(actionRecord())
    render(<ActionGateDock conversationId="chat-1" />)
    expect(await screen.findByTestId('gate-card')).toBeTruthy()
  })

  it('reacts to a new shared projection after mount', async () => {
    render(<ActionGateDock conversationId="chat-1" />)
    emitProjection(projectionWithActive(actionRecord()))
    expect(await screen.findByTestId('gate-card')).toBeTruthy()
  })

  it('explains a pending task without exposing its internal risk token', async () => {
    render(<ActionGateDock conversationId="chat-1" />)
    emitProjection(projectionWithActive(actionRecord()))
    expect(await screen.findByText('Approval needed')).toBeTruthy()
    expect(screen.getByText('Send a message to Ali')).toBeTruthy()
    expect(screen.getByText('ali@x.test')).toBeTruthy()
    expect(screen.getByText('This action cannot be undone.')).toBeTruthy()
    expect(screen.queryByText('irreversible')).toBeNull()
  })

  it('shows the approval in its matching Chat in Pro', async () => {
    window.api = { ...window.api, isPro: true } as never
    render(<ActionGateDock conversationId="chat-1" />)
    emitProjection(projectionWithActive(actionRecord()))
    expect(await screen.findByTestId('gate-card')).toBeTruthy()
  })

  it('does not show an approval owned by another Chat', async () => {
    render(<ActionGateDock conversationId="chat-2" />)
    emitProjection(projectionWithActive(actionRecord()))
    await waitFor(() => expect(screen.queryByTestId('gate-card')).toBeNull())
  })

  it('does not show an approval when no Chat is open', async () => {
    render(<ActionGateDock conversationId={null} />)
    emitProjection(projectionWithActive(actionRecord()))
    await waitFor(() => expect(screen.queryByTestId('gate-card')).toBeNull())
  })

  it('shows only actions that are awaiting approval', async () => {
    render(<ActionGateDock conversationId="chat-1" />)
    emitProjection(projectionWithActive(actionRecord({ state: 'executing' })))
    await waitFor(() => expect(screen.queryByTestId('gate-card')).toBeNull())
  })

  it('does not duplicate completed terminal outcomes above the composer', async () => {
    const done = actionRecord({ state: 'done', effectId: 'message-1' })
    const terminal: UseSnapshot['terminal'][number] = {
      actionId: done.id,
      outcome: 'done',
      record: done,
      completedAt: 2,
      undoneAt: null,
      availableIntents: ['undo']
    }
    render(<ActionGateDock conversationId="chat-1" />)
    emitProjection({ ...EMPTY_PROJECTION, terminal: [terminal] })
    await waitFor(() => expect(screen.queryByTestId('outcome-row')).toBeNull())
  })

  it('sends an approve intent for the projected action', async () => {
    render(<ActionGateDock conversationId="chat-1" />)
    emitProjection(projectionWithActive(actionRecord()))
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(resolveGate).toHaveBeenCalledWith('act_1', { kind: 'approve' })
  })

  it('keeps the card until Shared projects the approval transition', async () => {
    render(<ActionGateDock conversationId="chat-1" />)
    emitProjection(projectionWithActive(actionRecord()))
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(screen.getByTestId('gate-card')).toBeTruthy()
    emitProjection(EMPTY_PROJECTION)
    await waitFor(() => expect(screen.queryByTestId('gate-card')).toBeNull())
  })

  it('sends reject and clears only after Shared projects the transition', async () => {
    render(<ActionGateDock conversationId="chat-1" />)
    emitProjection(projectionWithActive(actionRecord()))
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    expect(resolveGate).toHaveBeenCalledWith('act_1', {
      kind: 'reject',
      reason: 'declined in chat'
    })
    expect(screen.getByTestId('gate-card')).toBeTruthy()
    emitProjection(EMPTY_PROJECTION)
    await waitFor(() => expect(screen.queryByTestId('gate-card')).toBeNull())
  })

  it('sends edited arguments back through the gate', async () => {
    render(<ActionGateDock conversationId="chat-1" />)
    emitProjection(projectionWithActive(actionRecord()))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('edit text'), {
      target: { value: 'the v2 deck is ready' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(resolveGate).toHaveBeenCalledWith('act_1', {
      kind: 'edit',
      args: { to: 'ali@x.test', text: 'the v2 deck is ready' }
    })
  })

  it('does not turn approval chatter into an executable task', async () => {
    const chatter = actionRecord({
      type: 'computer_use',
      intent: 'approved. please proceed',
      args: { goal: 'approved. please proceed' },
      risk: 'mutate'
    })
    render(<ActionGateDock conversationId="chat-1" />)
    emitProjection(projectionWithActive(chatter))
    expect(await screen.findByText('Review this action')).toBeTruthy()
    expect(screen.getByText('Add the task you want Off Grid AI to complete.')).toBeTruthy()
    expect(screen.getByText('Add the task details before you approve.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText(/approved\. please proceed/i)).toBeNull()
    expect(screen.queryByText('mutate')).toBeNull()
  })

  it('shows projected proposal inputs as a clear task plan', async () => {
    const proposal = actionRecord({
      type: 'computer_use',
      intent: 'Generate the proposal deck',
      args: {
        sourceFolder: '/Documents/Investor Relations',
        outputPath: '/Documents/Proposal.pptx',
        style: 'ABSLI proposal'
      },
      risk: 'mutate'
    })
    render(<ActionGateDock conversationId="chat-1" />)
    emitProjection(projectionWithActive(proposal))
    expect(await screen.findByText('Generate the proposal deck')).toBeTruthy()
    expect(screen.getByText('Source folder')).toBeTruthy()
    expect(screen.getByText('/Documents/Investor Relations')).toBeTruthy()
    expect(screen.getByText('Save to')).toBeTruthy()
    expect(screen.getByText('/Documents/Proposal.pptx')).toBeTruthy()
    expect(screen.getByText('Style')).toBeTruthy()
    expect(screen.getByText('ABSLI proposal')).toBeTruthy()
  })

  it('shows a durable recovery with its honest failure detail', async () => {
    render(<ActionGateDock conversationId="chat-1" />)
    emitProjection(projectionWithRecovery(actionRecord()))
    expect((await screen.findByTestId('outcome-row')).textContent).toContain(
      'Ran but could not be confirmed - needs your attention (The destination rejected the change.)'
    )
  })

  it('sends Retry for the projected recovery action', async () => {
    render(<ActionGateDock conversationId="chat-1" />)
    emitProjection(projectionWithRecovery(actionRecord()))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledWith('act_1')
  })

  it('does not show a recovery owned by another Chat', async () => {
    render(<ActionGateDock conversationId="chat-2" />)
    emitProjection(projectionWithRecovery(actionRecord()))
    await waitFor(() => expect(screen.queryByTestId('outcome-row')).toBeNull())
  })

  it('unsubscribes from the shared projection on unmount', () => {
    const { unmount } = render(<ActionGateDock conversationId="chat-1" />)
    unmount()
    expect(offProjection).toHaveBeenCalledOnce()
  })
})
