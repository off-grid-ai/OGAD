// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComputerUseSettingsSection } from '../ComputerUseSettingsSection'
import { COMPUTER_USE_SETTINGS_KEY } from '../../../../shared/computer-use-settings'

const saveSetting = vi.fn(async () => true)

beforeEach(() => {
  saveSetting.mockReset()
  saveSetting.mockResolvedValue(true)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getSettings: vi.fn().mockResolvedValue({
      [COMPUTER_USE_SETTINGS_KEY]: {
        context: '16k',
        screenshotSize: 'compact',
        screenshotQuality: 'efficient',
        checkpointInterval: 8,
        retrieveOlderVisuals: false
      }
    }),
    saveSetting
  }
})

afterEach(() => cleanup())

describe('<ComputerUseSettingsSection/>', () => {
  it('loads one persisted settings object and saves a complete normalized update', async () => {
    const user = userEvent.setup()
    render(<ComputerUseSettingsSection />)

    const context = await screen.findByRole('button', { name: 'Computer Use task context' })
    await waitFor(() => expect(context.textContent).toContain('16K'))
    await user.click(context)
    await user.click(screen.getByRole('menuitemradio', { name: '32K' }))

    expect(saveSetting).toHaveBeenCalledWith(
      COMPUTER_USE_SETTINGS_KEY,
      expect.objectContaining({
        context: '32k',
        screenshotSize: 'compact',
        checkpointInterval: 8
      })
    )
  })

  it('makes older visual context explicit and persists the toggle', async () => {
    const user = userEvent.setup()
    render(<ComputerUseSettingsSection />)

    const toggle = await screen.findByRole('switch', { name: 'Use past task facts' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await user.click(toggle)

    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(saveSetting).toHaveBeenCalledWith(
      COMPUTER_USE_SETTINGS_KEY,
      expect.objectContaining({ retrieveOlderVisuals: true })
    )
    expect(screen.getByText(/Past screenshots stay out of the prompt/)).toBeTruthy()
  })
})
