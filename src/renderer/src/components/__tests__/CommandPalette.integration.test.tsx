// @vitest-environment jsdom
//
// ⌘K has to do two jobs at once: find a screen by name, and keep finding the content it always
// found. The real palette runs here; only the search call at the window.api boundary is provided.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The palette reads window.api when its module loads, as the renderer does at boot, so the boundary
// is installed before the import.
let CommandPalette: typeof import('../CommandPalette').CommandPalette
let hits: unknown[] = []

const SCREENS = [
  { label: 'Devices', view: 'devices' },
  { label: 'Integrations', view: 'connectors' },
  { label: 'Models', view: 'models' },
  { label: 'Vault', view: 'vault', locked: true },
  { label: 'Settings', view: 'settings' }
]

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = { universalSearch: async () => hits }
  CommandPalette = (await import('../CommandPalette')).CommandPalette
})

describe('command palette', () => {
  beforeEach(() => {
    // jsdom has no scrollIntoView, which cmdk calls when it moves the highlight.
    Element.prototype.scrollIntoView = (): void => {}
    vi.useRealTimers()
    hits = [
      {
        key: 'memory-1',
        kind: 'memory',
        title: 'Sync design notes',
        snippet: 'the mesh reconciles'
      }
    ]
  })

  afterEach(() => cleanup())

  const openPalette = async (): Promise<ReturnType<typeof userEvent.setup>> => {
    const user = userEvent.setup()
    render(
      <CommandPalette
        onOpenHit={() => {}}
        onSeeAll={() => {}}
        screens={SCREENS}
        onGoTo={goTo}
      />
    )
    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => expect(screen.getByPlaceholderText(/jump to a screen/i)).toBeTruthy())
    return user
  }

  let goTo = vi.fn()
  beforeEach(() => {
    goTo = vi.fn()
  })

  it('opens on ⌘K as a jump list of every screen', async () => {
    await openPalette()
    expect(screen.getByText('Go to')).toBeTruthy()
    for (const item of SCREENS) {
      expect(screen.getByText(item.label)).toBeTruthy()
    }
  })

  it('finds a screen by the word the user types for it, and still shows content results', async () => {
    const user = await openPalette()
    await user.type(screen.getByPlaceholderText(/jump to a screen/i), 'sync')

    // "sync" is not the label - Devices is the screen, and it must still be found.
    await waitFor(() => expect(screen.getByText('Screens')).toBeTruthy())
    expect(screen.getByText('Devices')).toBeTruthy()
    expect(screen.queryByText('Models')).toBeNull()
    // The content search it always did is untouched.
    await waitFor(() => expect(screen.getByText('Sync design notes')).toBeTruthy())
    expect(screen.getByText(/See all results/)).toBeTruthy()
  })

  it('navigates to the screen that was chosen, and closes', async () => {
    const user = await openPalette()
    await user.type(screen.getByPlaceholderText(/jump to a screen/i), 'preferences')
    await waitFor(() => expect(screen.getByText('Settings')).toBeTruthy())
    await user.click(screen.getByText('Settings'))

    await waitFor(() => expect(goTo).toHaveBeenCalledWith('settings'))
    expect(screen.queryByPlaceholderText(/jump to a screen/i)).toBeNull()
  })
})
