// @vitest-environment jsdom
/**
 * The private cloud (Boost) promo on Models and Settings. The real card and the real shared copy;
 * only the preload bridge (settings on disk, the browser, analytics to main) is provided.
 *
 * The product rule this pins: everyone sees it; its button opens the offer page in the browser,
 * tagged with where it was clicked; closing it keeps it closed, also after a relaunch; a new
 * promo version shows it once more.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BOOST_PROMO } from '@offgrid/models'
import { BoostPromo, BoostPromoLine, BOOST_PROMO_SETTING } from '../BoostPromo'

function bridge(saved: Record<string, unknown> = {}): {
  settings: Record<string, unknown>
  opened: string[]
  events: Array<[string, unknown]>
} {
  const state = {
    settings: { ...saved },
    opened: [] as string[],
    events: [] as Array<[string, unknown]>
  }
  ;(window as unknown as { api: unknown }).api = {
    getSettings: async () => ({ ...state.settings }),
    saveSetting: async (key: string, value: unknown) => {
      state.settings[key] = value
      return true
    },
    openExternal: (url: string) => state.opened.push(url),
    analytics: { capture: (event: string, props: unknown) => state.events.push([event, props]) }
  }
  return state
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('the private cloud promo', () => {
  it('shows the offer and opens its page in the browser, tagged with where it was clicked', async () => {
    const api = bridge()
    render(<BoostPromo surface="model_settings" />)
    expect(await screen.findByText('Smarter answers, without a new computer.')).toBeTruthy()

    fireEvent.click(screen.getByTestId('boost-promo-claim'))

    expect(api.opened).toEqual([
      'https://getoffgridai.co/boost?utm_source=off-grid-desktop-app&utm_medium=boost-model-settings&utm_campaign=in-app'
    ])
    expect(api.events).toEqual([
      ['boost_promo_shown', { surface: 'model_settings' }],
      ['boost_promo_clicked', { surface: 'model_settings' }]
    ])
  })

  it('stays closed once closed, also after a relaunch', async () => {
    const api = bridge()
    const first = render(<BoostPromo surface="models" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))

    expect(screen.queryByTestId('boost-promo')).toBeNull()
    await waitFor(() => expect(api.settings[BOOST_PROMO_SETTING]).toBe(BOOST_PROMO.version))
    first.unmount()

    render(<BoostPromo surface="models" />)
    // Let the saved settings load, then nothing shows and nothing more is reported.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByTestId('boost-promo')).toBeNull()
    expect(api.events.map(([event]) => event)).toEqual([
      'boost_promo_shown',
      'boost_promo_dismissed'
    ])
  })

  it('shows again once a new version of the promo ships', async () => {
    bridge({ [BOOST_PROMO_SETTING]: 'an-older-promo' })
    render(<BoostPromo surface="models" />)
    expect(await screen.findByTestId('boost-promo')).toBeTruthy()
  })

  it('in onboarding: one line with the offer and a link to its page', () => {
    const api = bridge()
    render(<BoostPromoLine />)
    expect(screen.getByTestId('boost-promo-line').textContent).toContain(
      'Smarter answers, without a new computer.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Claim my discount' }))
    expect(api.opened).toEqual([
      'https://getoffgridai.co/boost?utm_source=off-grid-desktop-app&utm_medium=boost-onboarding&utm_campaign=in-app'
    ])
    expect(api.events).toEqual([
      ['boost_promo_shown', { surface: 'onboarding' }],
      ['boost_promo_clicked', { surface: 'onboarding' }]
    ])
  })
})
