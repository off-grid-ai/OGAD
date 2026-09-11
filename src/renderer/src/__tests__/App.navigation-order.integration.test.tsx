// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installAppBoundary,
  installAppBrowserBoundary,
  installAppStorage
} from './harness/app-boundary'

let App: typeof import('../App').default

describe('<App/> navigation order integration', () => {
  beforeAll(async () => {
    installAppBoundary()
    installAppBrowserBoundary()
    ;({ default: App } = await import('../App'))
  }, 30_000)

  beforeEach(() => {
    installAppStorage().setItem('onboarding_completed', 'true')
    window.history.replaceState(null, '', '/models')
    installAppBrowserBoundary()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('places Explore directly after Chat and opens it from the Work section', async () => {
    const user = userEvent.setup()
    render(<App />)

    const navigation = await screen.findByRole('navigation', { name: 'Primary navigation' })
    await user.hover(navigation)
    await waitFor(() => expect(navigation.getAttribute('aria-expanded')).toBe('true'))

    const discover = within(navigation).getByRole('group', { name: 'Discover' })
    const work = within(navigation).getByRole('group', { name: 'Work' })
    const chat = within(work).getByRole('button', { name: 'Chat' })
    const explore = within(work).getByRole('button', { name: 'Explore' })
    const workButtons = within(work).getAllByRole('button')

    expect(within(discover).queryByRole('button', { name: 'Explore' })).toBeNull()
    expect(workButtons.indexOf(explore)).toBe(workButtons.indexOf(chat) + 1)

    await user.click(explore)

    expect(await screen.findByRole('heading', { level: 1, name: 'Explore' })).toBeTruthy()
    expect(window.location.pathname).toBe('/explore')
  }, 30_000)
})
