// @vitest-environment jsdom
//
// Every top-level screen renders in the one page shell (PageShell): the standard header, and the
// page gutters and top padding from the shell, never from the screen. This mounts the real App and
// opens every route in VIEW_MODES, so adding a route that skips the shell fails here. Only the
// preload/browser boundary is faked. This build is free, so Pro routes show the upgrade screen; the
// Pro screens themselves are mounted by pro's own guard (pro/renderer/__tests__).

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearProFeaturesRenderer } from '../bootstrap/loadProFeaturesRenderer'
import { TooltipProvider } from '../components/ui/tooltip'
import { VIEW_MODES, type ViewMode } from '../lib/view-modes'
import {
  installAppBoundary,
  installAppBrowserBoundary,
  installAppStorage
} from './harness/app-boundary'
import { expectPageShell, routePathOf } from './harness/page-shell'

let App: typeof import('../App').default

describe('<App/> every top-level screen renders in the page shell', () => {
  beforeAll(async () => {
    installAppBoundary()
    installAppBrowserBoundary()
    ;({ default: App } = await import('../App'))
  }, 30_000)

  beforeEach(() => {
    installAppStorage().setItem('onboarding_completed', 'true')
    window.history.replaceState(null, '', '/models')
    installAppBrowserBoundary()
    installAppBoundary({ isPro: false })
  })

  afterEach(() => {
    cleanup()
    clearProFeaturesRenderer()
    vi.unstubAllGlobals()
  })

  it('opens Settings with the shell gutters and top padding', async () => {
    window.history.replaceState(null, '', '/settings')
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>
    )
    await waitFor(() => expect(window.location.pathname).toBe('/settings'))
    await waitFor(() => expectPageShell('settings'))
  }, 30_000)

  it.each(VIEW_MODES.map((view) => [view]))(
    '%s renders the standard header on the page gutters',
    async (view: ViewMode) => {
      render(
        <TooltipProvider>
          <App />
        </TooltipProvider>
      )
      await waitFor(() =>
        expect(document.querySelector('[data-route-host] [data-slot="page-shell"]')).not.toBeNull()
      )
      act(() => {
        window.dispatchEvent(new CustomEvent('og:navigate', { detail: view }))
      })
      await waitFor(() => expect(window.location.pathname).toBe(routePathOf(view)))
      await waitFor(() => expectPageShell(view))
    },
    30_000
  )
})
