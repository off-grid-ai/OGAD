// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyticsPromptKind } from '../../../../../shared/analytics'
import { AnalyticsPrompt } from '../AnalyticsPrompt'

/**
 * The consent prompt main asks for. Share is an icon button, so the person finds it by its name
 * ("Share"). Only the preload bridge is faked: it is the process boundary.
 */

let ask: (kind: AnalyticsPromptKind) => void = () => {}

const api = {
  analytics: {
    onPrompt: vi.fn((cb: (kind: AnalyticsPromptKind) => void) => {
      ask = cb
      return () => {}
    }),
    optIn: vi.fn(),
    dismissPrompt: vi.fn()
  }
}

describe('The analytics consent prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
  })

  afterEach(() => cleanup())

  it('opts in from the failure prompt with Share', async () => {
    const user = userEvent.setup()
    render(<AnalyticsPrompt />)
    act(() => ask('failure'))

    await user.click(await screen.findByRole('button', { name: 'Share' }))

    expect(api.analytics.optIn).toHaveBeenCalledWith('failure_prompt')
    expect(api.analytics.dismissPrompt).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opts in from the first-chat prompt with its own source', async () => {
    const user = userEvent.setup()
    render(<AnalyticsPrompt />)
    act(() => ask('first_chat'))

    await user.click(await screen.findByRole('button', { name: 'Share' }))

    expect(api.analytics.optIn).toHaveBeenCalledWith('first_chat_prompt')
  })

  it('dismisses without opting in on Not now', async () => {
    const user = userEvent.setup()
    render(<AnalyticsPrompt />)
    act(() => ask('failure'))

    await user.click(await screen.findByRole('button', { name: 'Not now' }))

    expect(api.analytics.dismissPrompt).toHaveBeenCalled()
    expect(api.analytics.optIn).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
