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

  it('places Explore directly after Chat and opens it from Work', async () => {
    const user = userEvent.setup()
    render(<App />)

    const navigation = await screen.findByRole('navigation', { name: 'Primary navigation' })
    await user.hover(navigation)

    const work = within(navigation).getByRole('group', { name: 'Work' })
    const chat = within(work).getByRole('button', { name: 'Chat' })
    const explore = within(work).getByRole('button', { name: 'Explore' })
    const workButtons = within(work).getAllByRole('button')

    expect(workButtons.indexOf(explore)).toBe(workButtons.indexOf(chat) + 1)

    await user.click(explore)

    expect(await screen.findByRole('heading', { level: 1, name: 'Explore' })).toBeTruthy()
    expect(window.location.pathname).toBe('/explore')
  }, 30_000)
})
