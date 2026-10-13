// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsSection } from '../SettingsSection'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('<SettingsSection/>', () => {
  it('shows its summary while closed, its rows when opened, and remembers the choice', async () => {
    const user = userEvent.setup()
    const { unmount } = render(
      <SettingsSection id="sampling" title="Sampling" summary="Top-P 0.95 · Top-K 40">
        <label>Top-P</label>
      </SettingsSection>
    )
    expect(screen.getByText('Top-P 0.95 · Top-K 40')).toBeTruthy()
    expect(screen.queryByText('Top-P')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Sampling/ }))
    expect(screen.getByText('Top-P')).toBeTruthy()

    unmount()
    render(
      <SettingsSection id="sampling" title="Sampling">
        <label>Top-P</label>
      </SettingsSection>
    )
    expect(screen.getByText('Top-P')).toBeTruthy()
  })

  it('opens the first time when asked to', () => {
    render(
      <SettingsSection id="basics" title="Basics" defaultOpen>
        <label>Temperature</label>
      </SettingsSection>
    )
    expect(screen.getByText('Temperature')).toBeTruthy()
  })
})
