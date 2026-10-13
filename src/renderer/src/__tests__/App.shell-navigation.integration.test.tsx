// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installAppBoundary,
  installAppBrowserBoundary,
  installAppStorage
} from './harness/app-boundary'

let App: typeof import('../App').default

describe('<App/> shell navigation integration', () => {
  beforeAll(async () => {
    installAppBoundary()
    installAppBrowserBoundary()
    ;({ default: App } = await import('../App'))
  }, 30_000)

  beforeEach(() => {
    const storage = installAppStorage()
    storage.setItem('onboarding_completed', 'true')
    storage.removeItem('sidebar_pinned')
    window.history.replaceState(null, '', '/models')
    installAppBrowserBoundary()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps the sidebar open when pinned and returns to hover after unpinning', async () => {
    const user = userEvent.setup()
    render(<App />)

    const navigation = await screen.findByRole('navigation', { name: 'Primary navigation' })
    await user.hover(navigation)
    fireEvent.click(screen.getByRole('button', { name: 'Pin sidebar' }))
    await user.unhover(navigation)

    expect(navigation.getAttribute('aria-expanded')).toBe('true')
    expect(localStorage.getItem('sidebar_pinned')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Unpin sidebar' }))
    await user.unhover(navigation)

    await waitFor(() => expect(navigation.getAttribute('aria-expanded')).toBe('false'))
    expect(localStorage.getItem('sidebar_pinned')).toBe('false')
  })

  it('places God directly after Chat, marked Pro, and shows a free build what it does', async () => {
    const user = userEvent.setup()
    render(<App />)

    const navigation = await screen.findByRole('navigation', { name: 'Primary navigation' })
    await user.hover(navigation)

    const work = within(navigation).getByRole('group', { name: 'Work' })
    const chat = within(work).getByRole('button', { name: 'Chat' })
    const twin = within(work).getByRole('button', { name: 'God' })
    const workButtons = within(work).getAllByRole('button')

    expect(workButtons.indexOf(twin)).toBe(workButtons.indexOf(chat) + 1)
    // God is Pro: a free build marks it and opens its upgrade screen, never the chat.
    expect(within(twin).queryByTitle('Pro')).toBeTruthy()

    await user.click(twin)

    expect(await screen.findByRole('heading', { level: 1, name: 'God' })).toBeTruthy()
    expect(
      screen.getByText('Your assistant. It knows your day and asks before it acts.')
    ).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Ask God' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Talk to Ares' })).toBeNull()
    expect(window.location.pathname).toBe('/explore')
  }, 30_000)
})
