// @vitest-environment jsdom
/**
 * The inline action surface: a pending gate renders as a card whose Approve/
 * Edit/Reject resolve through the engine gate; outcomes land as verified
 * confirmations with Undo when the handler can reverse the effect. The
 * preload feed is the only fake - the component logic is real.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionGateDock as ProductActionGateDock } from '../ActionGateDock'

function ActionGateDock({
  conversationId = 'chat-1'
}: {
  conversationId?: string
}): React.JSX.Element | null {
  return <ProductActionGateDock conversationId={conversationId} />
}

type Listener = (payload: unknown) => void

let emitPending: Listener
let emitOutcome: Listener
const resolveGate = vi.fn(async () => true)
const undo = vi.fn(async () => ({ ok: true }))

beforeEach(() => {
  resolveGate.mockClear()
  undo.mockClear()
  window.api = {
    actions: {
      resolveGate,
      undo,
      onGatePending: (cb: Listener) => {
        emitPending = cb
        return () => {}
      },
      onOutcome: (cb: Listener) => {
        emitOutcome = cb
        return () => {}
      }
    }
  } as never
})

afterEach(cleanup)

const request = {
  actionId: 'act_1',
  actionType: 'message',
  title: 'Send a message to Ali',
  args: { to: 'ali@x.test', text: 'the deck is ready' },
  risk: 'irreversible',
  sourceRef: 'chat-1'
}

describe('<ActionGateDock/>', () => {
  it('renders nothing until something needs attention', () => {
    const { container } = render(<ActionGateDock />)
    expect(container.firstChild).toBeNull()
  })

  it('a pending gate explains the task without exposing internal risk tokens', async () => {
    render(<ActionGateDock />)
    emitPending(request)
    await waitFor(() => expect(screen.getByTestId('gate-card')).toBeTruthy())
    expect(screen.getByText('Approval needed')).toBeTruthy()
    expect(screen.getByText('Send a message to Ali')).toBeTruthy()
    expect(screen.getByText('ali@x.test')).toBeTruthy()
    expect(screen.getByText('This action cannot be undone.')).toBeTruthy()
    expect(screen.queryByText('irreversible')).toBeNull()
  })

  it('shows the approval in its matching Chat in Pro', async () => {
    window.api = { ...window.api, isPro: true } as never
    render(<ActionGateDock />)
    emitPending(request)
    await waitFor(() => expect(screen.getByTestId('gate-card')).toBeTruthy())
  })

  it('does not show the approval in another open Chat', async () => {
    render(<ActionGateDock conversationId="chat-2" />)
    emitPending(request)
    await waitFor(() => expect(screen.queryByTestId('gate-card')).toBeNull())
  })

  it('does not duplicate Pro execution outcomes above the composer', async () => {
    window.api = { ...window.api, isPro: true } as never
    render(<ActionGateDock />)
    emitOutcome({ id: 'act_pro', outcome: 'needs_help', undoable: false, record: {} })
    await waitFor(() => expect(screen.queryByTestId('outcome-row')).toBeNull())
  })

  it('Approve resolves the gate with the approve decision', async () => {
    render(<ActionGateDock />)
    emitPending(request)
    await waitFor(() => screen.getByTestId('gate-card'))
    fireEvent.click(screen.getByText('Approve'))
    expect(resolveGate).toHaveBeenCalledWith('act_1', { kind: 'approve' })
  })

  it('Approve dismisses the card immediately, without waiting for the outcome', async () => {
    render(<ActionGateDock />)
    emitPending(request)
    await waitFor(() => screen.getByTestId('gate-card'))
    fireEvent.click(screen.getByText('Approve'))
    // Gone the instant it's approved - no outcome event has been emitted.
    expect(screen.queryByTestId('gate-card')).toBeNull()
  })

  it('Reject declines; the card clears when the outcome arrives', async () => {
    render(<ActionGateDock />)
    emitPending(request)
    await waitFor(() => screen.getByTestId('gate-card'))
    fireEvent.click(screen.getByText('Reject'))
    expect(resolveGate).toHaveBeenCalledWith('act_1', {
      kind: 'reject',
      reason: 'declined in chat'
    })
    emitOutcome({ id: 'act_1', outcome: 'rejected', record: { intent: 'Send a message to Ali' } })
    await waitFor(() => expect(screen.queryByTestId('gate-card')).toBeNull())
    expect(screen.getByText(/Declined/)).toBeTruthy()
  })

  it('Edit turns the args editable and Save sends the edited payload for re-gating', async () => {
    render(<ActionGateDock />)
    emitPending(request)
    await waitFor(() => screen.getByTestId('gate-card'))
    fireEvent.click(screen.getByText('Edit'))
    const field = screen.getByLabelText('edit text') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'the v2 deck is ready' } })
    fireEvent.click(screen.getByText('Save changes'))
    expect(resolveGate).toHaveBeenCalledWith('act_1', {
      kind: 'edit',
      args: { to: 'ali@x.test', text: 'the v2 deck is ready' }
    })
  })

  it('a done outcome shows the verified confirmation, and Undo reverses it', async () => {
    render(<ActionGateDock />)
    emitOutcome({
      id: 'act_2',
      outcome: 'done',
      undoable: true,
      record: { type: 'reminder', intent: 'Create the reminder "Send the deck"', effectId: 'rt1' }
    })
    await waitFor(() => screen.getByTestId('outcome-row'))
    expect(screen.getByText(/Done - verified/)).toBeTruthy()
    fireEvent.click(screen.getByText('Undo'))
    await waitFor(() => expect(screen.getByText(/Undone/)).toBeTruthy())
    expect(undo).toHaveBeenCalled()
  })

  it('a non-undoable outcome offers no Undo, and needs_help reads honestly', async () => {
    render(<ActionGateDock />)
    emitOutcome({ id: 'act_3', outcome: 'needs_help', undoable: false, record: {} })
    await waitFor(() => screen.getByTestId('outcome-row'))
    expect(screen.queryByText('Undo')).toBeNull()
    expect(screen.getByText(/needs your attention/)).toBeTruthy()
  })

  it('Dismiss clears an outcome row', async () => {
    render(<ActionGateDock />)
    emitOutcome({ id: 'act_4', outcome: 'done', undoable: false, record: {} })
    await waitFor(() => screen.getByTestId('outcome-row'))
    fireEvent.click(screen.getByLabelText('Dismiss'))
    await waitFor(() => expect(screen.queryByTestId('outcome-row')).toBeNull())
  })

  it('approval chatter cannot become a new executable task', async () => {
    render(<ActionGateDock />)
    emitPending({
      ...request,
      actionType: 'computer_task',
      title: 'approved. please proceed',
      args: { goal: 'approved. please proceed' },
      risk: 'mutate'
    })
    await waitFor(() => screen.getByTestId('gate-card'))
    expect(screen.getByText('Review this action')).toBeTruthy()
    expect(screen.getByText('Add the task you want Off Grid AI to complete.')).toBeTruthy()
    expect(screen.getByText('Add the task details before you approve.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText(/approved\. please proceed/i)).toBeNull()
    expect(screen.queryByText('mutate')).toBeNull()
  })

  it('shows proposal inputs as a clear task plan', async () => {
    render(<ActionGateDock />)
    emitPending({
      ...request,
      actionType: 'computer_task',
      title: 'Generate the proposal deck',
      args: {
        sourceFolder: '/Documents/Investor Relations',
        outputPath: '/Documents/Proposal.pptx',
        style: 'ABSLI proposal'
      },
      risk: 'mutate'
    })
    await waitFor(() => screen.getByTestId('gate-card'))
    expect(screen.getByText('Generate the proposal deck')).toBeTruthy()
    expect(screen.getByText('Source folder')).toBeTruthy()
    expect(screen.getByText('/Documents/Investor Relations')).toBeTruthy()
    expect(screen.getByText('Save to')).toBeTruthy()
    expect(screen.getByText('/Documents/Proposal.pptx')).toBeTruthy()
    expect(screen.getByText('Style')).toBeTruthy()
    expect(screen.getByText('ABSLI proposal')).toBeTruthy()
  })

  it('an edited outcome never lands as a row - the re-gated card is its own event', async () => {
    render(<ActionGateDock />)
    emitPending(request)
    await waitFor(() => screen.getByTestId('gate-card'))
    emitOutcome({ id: 'act_1', outcome: 'edited', record: {} })
    await waitFor(() => expect(screen.queryByTestId('gate-card')).toBeNull())
    expect(screen.queryByTestId('outcome-row')).toBeNull()
  })

  it('a failed undo reports the detail instead of pretending it worked', async () => {
    undo.mockResolvedValueOnce({ ok: false, detail: 'no reminder with id rt9' } as never)
    render(<ActionGateDock />)
    emitOutcome({ id: 'act_5', outcome: 'done', undoable: true, record: { effectId: 'rt9' } })
    await waitFor(() => screen.getByTestId('outcome-row'))
    fireEvent.click(screen.getByText('Undo'))
    await waitFor(() => expect(screen.getByText(/no reminder with id rt9/)).toBeTruthy())
    expect(screen.queryByText('Undo')).toBeNull()
  })

  it('a poisoned outcome carries the honest error text', async () => {
    render(<ActionGateDock />)
    emitOutcome({ id: 'act_6', outcome: 'poisoned', error: 'helper unavailable', record: {} })
    await waitFor(() => screen.getByTestId('outcome-row'))
    expect(screen.getByText(/Failed.*helper unavailable/)).toBeTruthy()
  })

  it('an outcome for an action never shown as a card still lands, and old rows roll off past three', async () => {
    render(<ActionGateDock />)
    for (const id of ['r1', 'r2', 'r3', 'r4']) {
      emitOutcome({ id, outcome: 'done', undoable: false, record: { intent: id } })
    }
    await waitFor(() => expect(screen.getAllByTestId('outcome-row')).toHaveLength(3))
    expect(screen.queryByText(/r1 -/)).toBeNull()
  })

  it('unmount unsubscribes from the preload feed', () => {
    const offPending = vi.fn()
    const offOutcome = vi.fn()
    window.api = {
      actions: {
        resolveGate,
        undo,
        onGatePending: () => offPending,
        onOutcome: () => offOutcome
      }
    } as never
    const { unmount } = render(<ActionGateDock />)
    unmount()
    expect(offPending).toHaveBeenCalled()
    expect(offOutcome).toHaveBeenCalled()
  })
})
