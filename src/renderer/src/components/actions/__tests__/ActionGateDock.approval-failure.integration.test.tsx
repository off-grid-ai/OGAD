// @vitest-environment jsdom

/**
 * The application action gate through the real rendered approval dock. The Electron preload is
 * the only fake boundary: it publishes the application request and terminal outcome, while the
 * component owns the user decision and visible result.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ActionGateDock } from '../ActionGateDock'

type EventListener = (event: unknown) => void

class ActionBoundary {
  private pendingListener: EventListener | null = null
  private outcomeListener: EventListener | null = null

  readonly api = {
    isPro: false,
    actions: {
      onGatePending: (listener: EventListener) => {
        this.pendingListener = listener
        return () => {
          this.pendingListener = null
        }
      },
      onOutcome: (listener: EventListener) => {
        this.outcomeListener = listener
        return () => {
          this.outcomeListener = null
        }
      },
      resolveGate: async (actionId: string, decision: unknown) => {
        this.outcomeListener?.({
          id: actionId,
          outcome: 'poisoned',
          error: 'The destination rejected the change.',
          record: { intent: 'Update the release calendar' }
        })
        return { accepted: true, decision }
      },
      undo: async () => ({ ok: false, detail: 'This action cannot be undone.' })
    }
  }

  publishPending(): void {
    this.pendingListener?.({
      actionId: 'calendar-update',
      actionType: 'calendar',
      title: 'Update the release calendar',
      args: { date: 'September 8', event: 'Off Grid release' },
      risk: 'irreversible',
      sourceRef: 'conversation-a'
    })
  }
}

afterEach(cleanup)

describe('<ActionGateDock/> approval failure', () => {
  it('shows the application failure after the user approves the proposed action', async () => {
    const boundary = new ActionBoundary()
    Object.defineProperty(window, 'api', { configurable: true, value: boundary.api })
    const user = userEvent.setup()
    render(<ActionGateDock conversationId="conversation-a" />)

    act(() => boundary.publishPending())
    expect(await screen.findByText('Update the release calendar')).toBeTruthy()
    expect(screen.getByText('This action cannot be undone.')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Approve' }))

    expect(
      await screen.findByText(
        'Update the release calendar - Failed (The destination rejected the change.)'
      )
    ).toBeTruthy()
    expect(screen.queryByText('Approval needed')).toBeNull()
  })
})
